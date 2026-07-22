import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { getFfmpegCommand, normalizeVideo, isNormalized, getVideoConfig, triggerNormalization, getReferenceVideoName, getFreeDiskSpace, safeAppendToLog } from '@/lib/video';




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

        // Verify that the resolution, FPS, and video codec match the reference config
        if (targetConfig) {
          const fpsMatch = Math.abs(videoConfig.fps - targetConfig.fps) < 0.5;
          const isVideoH264 = videoConfig.codecVideo.includes('h264') || videoConfig.codecVideo.includes('avc');
          const isCompatible = 
            videoConfig.width === targetConfig.width &&
            videoConfig.height === targetConfig.height &&
            fpsMatch &&
            isVideoH264;

          if (!isCompatible) {
            console.error(`[Background] Validation failed for "${fileName}": Parameter mismatch.`);
            
            safeAppendToLog(`[${new Date().toISOString()}] [Upload Validation ERROR] Video "${fileName}" rejected. Resolution/FPS (${videoConfig.width}x${videoConfig.height}, ${videoConfig.fps} fps, codec: ${videoConfig.codecVideo}) must match reference (${targetConfig.width}x${targetConfig.height}, ${targetConfig.fps} fps, codec: ${targetConfig.codecVideo}).\n`);
            
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

// Startup cleanup check for orphaned files
let hasCleanedUpOrphans = false;
function cleanupOrphanedTempFiles() {
  if (hasCleanedUpOrphans) return;
  hasCleanedUpOrphans = true;
  
  try {
    if (!fs.existsSync(uploadsDir)) return;
    const files = fs.readdirSync(uploadsDir);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    for (const file of files) {
      if (
        (file.startsWith('temp_') && (file.endsWith('.part') || file.includes('_temp_') || file.includes('_chunk_'))) ||
        (file.startsWith('temp_') && file.includes('_') && file.endsWith('.mp4'))
      ) {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filePath);
          console.log(`[Startup Cleanup] Deleted orphaned temp upload file: ${file}`);
        }
      }
    }
  } catch (err) {
    console.error('[Startup Cleanup] Failed to clean up orphaned temp files:', err);
  }
}

// Asynchronous sequential merge helper
async function mergeChunks(chunkFiles: string[], finalFilePath: string): Promise<void> {
  const writeStream = fs.createWriteStream(finalFilePath);
  try {
    for (const chunkFile of chunkFiles) {
      const readStream = fs.createReadStream(chunkFile);
      try {
        readStream.pipe(writeStream, { end: false });
        await new Promise<void>((resolve, reject) => {
          readStream.on('end', resolve);
          readStream.on('error', reject);
        });
      } finally {
        readStream.destroy();
      }
    }
  } finally {
    writeStream.end();
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', () => resolve());
    writeStream.on('error', (err) => reject(err));
  });
}

export async function POST(request: Request) {
  cleanupOrphanedTempFiles();

  try {
    const { searchParams } = new URL(request.url);
    const chunkIndexStr = searchParams.get('chunkIndex');
    const totalChunksStr = searchParams.get('totalChunks');
    const fileName = searchParams.get('fileName');
    const uploadId = searchParams.get('uploadId');
    const totalSizeStr = searchParams.get('totalSize');

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

      // Disk Space Safeguard check for legacy upload
      const freeSpace = getFreeDiskSpace(uploadsDir);
      const requiredSpace = file.size + 50 * 1024 * 1024;
      if (freeSpace < requiredSpace) {
        const errMsg = `Upload rejected: Insufficient disk space on VPS. Upload requires ${requiredSpace} bytes, free space: ${freeSpace} bytes.`;
        console.error(`[Upload] ${errMsg}`);
        safeAppendToLog(`[${new Date().toISOString()}] [Upload ERROR] Legacy upload rejected: Insufficient disk space. Required: ${requiredSpace} bytes, Available: ${freeSpace} bytes.\n`);
        return NextResponse.json({ error: errMsg }, { status: 507 });
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
    const totalSize = totalSizeStr ? parseInt(totalSizeStr, 10) : 0;
    const tempChunkFilePath = path.join(uploadsDir, `temp_${uploadId}_chunk_${chunkIndex}.part`);

    // 3. Disk Space Safeguard check (on first chunk)
    if (chunkIndex === 0 && totalSize > 0) {
      const freeSpace = getFreeDiskSpace(uploadsDir);
      const requiredSpace = totalSize + 50 * 1024 * 1024;
      if (freeSpace < requiredSpace) {
        const errMsg = `Upload rejected: Insufficient disk space on VPS. Upload requires ${requiredSpace} bytes, free space: ${freeSpace} bytes.`;
        console.error(`[Upload] ${errMsg}`);
        safeAppendToLog(`[${new Date().toISOString()}] [Upload ERROR] Upload of "${fileName}" rejected: Insufficient disk space. Required: ${requiredSpace} bytes, Available: ${freeSpace} bytes.\n`);
        return NextResponse.json({ error: errMsg }, { status: 507 });
      }
    }

    // 4. Abort cleanup hook for this specific chunk
    const abortHandler = () => {
      console.log(`[Upload] Upload of chunk ${chunkIndex} (session ${uploadId}) aborted by client. Cleaning up...`);
      try {
        if (fs.existsSync(tempChunkFilePath)) {
          fs.unlinkSync(tempChunkFilePath);
          console.log(`[Upload Cleanup] Deleted aborted chunk file: ${tempChunkFilePath}`);
        }
      } catch (err: any) {
        console.error(`[Upload Cleanup] Failed to clean up chunk file on abort:`, err.message);
      }
    };
    request.signal.addEventListener('abort', abortHandler);

    try {
      // Stream the chunk data to its dedicated temp file
      const writeStream = fs.createWriteStream(tempChunkFilePath, { flags: 'w' });
      const nodeStream = Readable.fromWeb(request.body as any);
      nodeStream.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
        nodeStream.on('error', (err) => reject(err));
      });

      // Check if all chunks have finished uploading
      const chunkFiles = Array.from({ length: totalChunks }, (_, i) => 
        path.join(uploadsDir, `temp_${uploadId}_chunk_${i}.part`)
      );
      const allPresent = chunkFiles.every(f => fs.existsSync(f));

      if (allPresent) {
        const lockKey = `${uploadId}_${fileName}`;
        if (!(global as any).activeMerges) {
          (global as any).activeMerges = new Set<string>();
        }

        if (!(global as any).activeMerges.has(lockKey)) {
          (global as any).activeMerges.add(lockKey);

          // Offload stream merging completely to a background thread tick so the HTTP response returns immediately
          setImmediate(async () => {
            try {
              const finalFilePath = path.join(uploadsDir, fileName);
              if (fs.existsSync(finalFilePath)) {
                fs.unlinkSync(finalFilePath);
              }

              console.log(`[Upload] Starting background stream merge for "${fileName}" (${totalChunks} chunks)...`);
              await mergeChunks(chunkFiles, finalFilePath);
              console.log(`[Upload] Merge complete for "${fileName}". Cleaning up temp chunks.`);

              // Delete temp chunk files
              for (const chunkFile of chunkFiles) {
                try {
                  if (fs.existsSync(chunkFile)) {
                    fs.unlinkSync(chunkFile);
                  }
                } catch (e) {
                  console.error(`Failed to delete temp chunk file ${chunkFile}:`, e);
                }
              }

              triggerBackgroundNormalizationAndConfigUpdate(fileName, finalFilePath);
            } catch (err: any) {
              console.error(`[Upload] Failed to merge chunks for "${fileName}":`, err.message);
            } finally {
              (global as any).activeMerges.delete(lockKey);
            }
          });
        }
      }

      return NextResponse.json({ success: true, chunkIndex, totalChunks });
    } catch (writeError: any) {
      console.error(`[Upload] Error writing chunk ${chunkIndex} for ${fileName}:`, writeError);
      try {
        if (fs.existsSync(tempChunkFilePath)) {
          fs.unlinkSync(tempChunkFilePath);
        }
      } catch {}
      throw writeError;
    } finally {
      request.signal.removeEventListener('abort', abortHandler);
    }

  } catch (error: any) {
    console.error('Upload error details:', error);
    return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 });
  }
}