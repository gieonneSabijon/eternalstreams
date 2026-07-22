import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { getFfmpegCommand, normalizeVideo, isNormalized, getVideoConfig, triggerNormalization, getReferenceVideoName } from '@/lib/video';

const uploadsDir = path.join(process.cwd(), 'uploads');
const configPath = path.join(process.cwd(), 'stream-config.json');

// Helper to run validation, normalization, and configuration update in the background.
// This prevents blocking the HTTP request (preventing timeouts).
function triggerBackgroundNormalizationAndConfigUpdate(fileName: string, filePath: string) {
  (async () => {
    const ffmpegPath = getFfmpegCommand();
    try {
      // 1. Validate the video file first to ensure it's not corrupt (e.g. missing moov atom)
      let videoConfig;
      try {
        videoConfig = await getVideoConfig(filePath, ffmpegPath);
      } catch (validationErr: any) {
        console.error(`[Background] Validation failed for uploaded file "${fileName}" (corrupt or invalid video):`, validationErr);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        return; // Terminate early so we don't add a corrupt file to the playlist
      }

      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData);

        // Retrieve targetConfig from reference video if not set
        let targetConfig = config.targetConfig;
        if (!targetConfig) {
          const refVideoName = await getReferenceVideoName(uploadsDir, config.playlist);
          if (refVideoName) {
            const refVideoPath = path.join(uploadsDir, refVideoName);
            if (fs.existsSync(refVideoPath)) {
              try {
                targetConfig = await getVideoConfig(refVideoPath, ffmpegPath);
                config.targetConfig = targetConfig;
              } catch (err) {
                console.error(`[Background] Failed to get targetConfig from reference:`, err);
              }
            }
          }
        }

        // Verify that the resolution and FPS match the reference config
        if (targetConfig) {
          const fpsMatch = Math.abs(videoConfig.fps - targetConfig.fps) < 0.5;
          if (videoConfig.width !== targetConfig.width || videoConfig.height !== targetConfig.height || !fpsMatch) {
            console.error(`[Background] Validation failed for "${fileName}": Resolution/FPS mismatch.`);
            
            const logFilePath = path.join(process.cwd(), 'ffmpeg_log.txt');
            fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] [Upload Validation ERROR] Video "${fileName}" rejected. Resolution/FPS (${videoConfig.width}x${videoConfig.height}, ${videoConfig.fps} fps) must match reference (${targetConfig.width}x${targetConfig.height}, ${targetConfig.fps} fps).\n`);
            
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            return; // Terminate early (do not add to playlist)
          }
        }

        // Append to playlist immediately
        if (!Array.isArray(config.playlist)) {
          config.playlist = [];
        }
        if (!config.playlist.includes(fileName)) {
          config.playlist.push(fileName);
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Background] Appended "${fileName}" to playlist config`);

        // Trigger background normalization if targetConfig is available
        if (targetConfig) {
          const isNorm = await isNormalized(filePath, targetConfig, ffmpegPath);
          if (isNorm) {
            console.log(`[Background] Uploaded file "${fileName}" is already normalized to match reference configuration. Skipping.`);
          } else {
            triggerNormalization(fileName, targetConfig, ffmpegPath, config.bitrate, config.preset);
          }
        }
      }
    } catch (err) {
      console.error(`[Background] Failed to process uploaded file "${fileName}":`, err);
    }
  })();
}

// Memory-efficient sequential stream merge
async function mergeChunks(chunkFiles: string[], finalFilePath: string): Promise<void> {
  const writeStream = fs.createWriteStream(finalFilePath);
  for (const chunkFile of chunkFiles) {
    const readStream = fs.createReadStream(chunkFile);
    readStream.pipe(writeStream, { end: false });
    await new Promise<void>((resolve, reject) => {
      readStream.on('end', resolve);
      readStream.on('error', reject);
    });
  }
  writeStream.end();
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', () => resolve());
    writeStream.on('error', (err) => reject(err));
  });
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const chunkIndexStr = searchParams.get('chunkIndex');
    const totalChunksStr = searchParams.get('totalChunks');
    const fileName = searchParams.get('fileName');
    const uploadId = searchParams.get('uploadId');

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // 1. Legacy single file upload (missing chunking parameters)
    if (chunkIndexStr === null || totalChunksStr === null || !fileName || !uploadId) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const legacyFileName = file.name;
      const filePath = path.join(uploadsDir, legacyFileName);
      fs.writeFileSync(filePath, buffer);
      
      triggerBackgroundNormalizationAndConfigUpdate(legacyFileName, filePath);
      return NextResponse.json({ success: true, name: legacyFileName, size: file.size });
    }

    // 2. Streamed Chunked upload flow
    if (!request.body) {
      return NextResponse.json({ error: 'Request body stream is empty' }, { status: 400 });
    }

    const chunkIndex = parseInt(chunkIndexStr, 10);
    const totalChunks = parseInt(totalChunksStr, 10);
    const tempChunkFilePath = path.join(uploadsDir, `temp_${uploadId}_${chunkIndex}_${fileName}`);

    // Stream raw request body chunk directly to the temporary chunk file on disk
    const writeStream = fs.createWriteStream(tempChunkFilePath, { flags: 'w' });
    const nodeStream = Readable.fromWeb(request.body as any);
    nodeStream.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => reject(err));
      nodeStream.on('error', (err) => reject(err));
    });

    // Check if all chunks have been uploaded
    const chunkFiles = Array.from({ length: totalChunks }, (_, i) => 
      path.join(uploadsDir, `temp_${uploadId}_${i}_${fileName}`)
    );

    const allPresent = chunkFiles.every(f => fs.existsSync(f));

    if (allPresent) {
      const lockKey = `${uploadId}_${fileName}`;
      if (!(global as any).activeMerges) {
        (global as any).activeMerges = new Set<string>();
      }

      if (!(global as any).activeMerges.has(lockKey)) {
        (global as any).activeMerges.add(lockKey);
        try {
          const finalFilePath = path.join(uploadsDir, fileName);
          if (fs.existsSync(finalFilePath)) {
            fs.unlinkSync(finalFilePath);
          }

          await mergeChunks(chunkFiles, finalFilePath);

          // Clean up chunk files
          for (const chunkFile of chunkFiles) {
            try {
              fs.unlinkSync(chunkFile);
            } catch (unlinkErr) {
              console.error(`Failed to delete temp chunk file ${chunkFile}:`, unlinkErr);
            }
          }

          // Trigger background validation, normalization, and config update
          triggerBackgroundNormalizationAndConfigUpdate(fileName, finalFilePath);
        } finally {
          (global as any).activeMerges.delete(lockKey);
        }
      }
    }

    return NextResponse.json({ success: true, chunkIndex, totalChunks });
  } catch (error: any) {
    console.error('Upload error details:', error);
    return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 });
  }
}