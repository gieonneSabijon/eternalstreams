import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getFfmpegCommand, normalizeVideo } from '@/lib/video';

const uploadsDir = path.join(process.cwd(), 'uploads');
const configPath = path.join(process.cwd(), 'stream-config.json');

// Helper to run normalization and configuration update in the background.
// This prevents blocking the HTTP request (preventing timeouts).
function triggerBackgroundNormalizationAndConfigUpdate(fileName: string, filePath: string) {
  (async () => {
    try {
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData);

        // If live stream is running, dynamically normalize the uploaded file to match the stream configuration
        if (config.status === 'live' && config.targetConfig) {
          const ffmpegPath = getFfmpegCommand();
          console.log(`[Background] Live stream running. Dynamically normalizing uploaded file "${fileName}" to match targetConfig (${config.targetConfig.width}x${config.targetConfig.height}, ${config.targetConfig.fps}fps)`);
          const tempPath = filePath + '.tmp.mp4';
          await normalizeVideo(filePath, tempPath, config.targetConfig, ffmpegPath);
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(filePath);
            fs.renameSync(tempPath, filePath);
            console.log(`[Background] Successfully normalized uploaded file: ${fileName}`);
          }
        }
      }
    } catch (err) {
      console.error(`[Background] Failed to normalize uploaded file "${fileName}" dynamically against running stream:`, err);
    } finally {
      // 🚀 AUTOMATICALLY UPDATE CONFIG ON SUCCESSFUL UPLOAD
      try {
        if (fs.existsSync(configPath)) {
          const configData = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(configData);

          if (!Array.isArray(config.playlist)) {
            config.playlist = [];
          }

          // Only append if it's not already tracked in the playlist array
          if (!config.playlist.includes(fileName)) {
            config.playlist.push(fileName);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log(`[Background] Successfully appended "${fileName}" to loop playlist config`);
          }
        }
      } catch (configErr) {
        console.error('[Background] Failed to update config during upload sync:', configErr);
      }
    }
  })();
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    
    // Check for chunk parameters
    const fileChunk = formData.get('file') as File | null;
    const chunkIndexStr = formData.get('chunkIndex') as string | null;
    const totalChunksStr = formData.get('totalChunks') as string | null;
    const fileName = formData.get('fileName') as string | null;
    const uploadId = formData.get('uploadId') as string | null;

    if (!fileChunk) {
      return NextResponse.json({ error: 'No file/chunk uploaded' }, { status: 400 });
    }

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // 1. If it's a legacy single file upload (missing chunking parameters)
    if (chunkIndexStr === null || totalChunksStr === null || !fileName || !uploadId) {
      const buffer = Buffer.from(await fileChunk.arrayBuffer());
      const legacyFileName = fileChunk.name;
      const filePath = path.join(uploadsDir, legacyFileName);
      fs.writeFileSync(filePath, buffer);
      
      triggerBackgroundNormalizationAndConfigUpdate(legacyFileName, filePath);
      return NextResponse.json({ success: true, name: legacyFileName, size: fileChunk.size });
    }

    // 2. Chunked upload flow
    const chunkIndex = parseInt(chunkIndexStr, 10);
    const totalChunks = parseInt(totalChunksStr, 10);
    const tempFilePath = path.join(uploadsDir, `temp_${uploadId}_${fileName}`);
    
    const chunkBuffer = Buffer.from(await fileChunk.arrayBuffer());
    
    // Append this chunk to the temporary file on disk (low memory usage)
    fs.appendFileSync(tempFilePath, chunkBuffer);

    // If it's the last chunk, finalize the file
    if (chunkIndex === totalChunks - 1) {
      const finalFilePath = path.join(uploadsDir, fileName);
      if (fs.existsSync(finalFilePath)) {
        fs.unlinkSync(finalFilePath);
      }
      fs.renameSync(tempFilePath, finalFilePath);

      // Trigger background normalization and playlist update
      triggerBackgroundNormalizationAndConfigUpdate(fileName, finalFilePath);
    }

    return NextResponse.json({ success: true, chunkIndex, totalChunks });
  } catch (error: any) {
    console.error('Upload error details:', error);
    return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 });
  }
}