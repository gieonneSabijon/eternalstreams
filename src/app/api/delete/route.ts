import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { killProcess, startBroadcastHelper } from '../stream/route';

const uploadsDir = path.join(process.cwd(), 'uploads');
const configPath = path.join(process.cwd(), 'stream-config.json');

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const isTempCleanup = searchParams.get('temp') === 'true';

    if (isTempCleanup) {
      if (!fs.existsSync(uploadsDir)) {
        return NextResponse.json({ success: true, message: 'Uploads directory does not exist' });
      }
      const allFiles = fs.readdirSync(uploadsDir);
      let deletedCount = 0;
      allFiles.forEach((fileName) => {
        if (fileName.startsWith('temp_') || fileName.endsWith('.tmp.mp4')) {
          const filePath = path.join(uploadsDir, fileName);
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (e) {
            console.error(`Failed to delete temp file ${fileName}:`, e);
          }
        }
      });
      return NextResponse.json({ success: true, message: `Deleted ${deletedCount} temporary file(s)` });
    }

    const fileName = searchParams.get('file');

    if (!fileName) {
      return NextResponse.json({ error: 'File name parameter is required' }, { status: 400 });
    }

    const filePath = path.join(uploadsDir, fileName);

    // Security check to avoid path traversal
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(uploadsDir)) {
      return NextResponse.json({ error: 'Unauthorized access path' }, { status: 403 });
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Read config first to check status and check if this is the first video (reference video)
    let wasFirstVideo = false;
    let isStreamLive = false;
    let config: any = null;
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(configData);
        if (Array.isArray(config.playlist)) {
          wasFirstVideo = config.playlist[0] === fileName;
        }
        isStreamLive = config.status === 'live';
      } catch (e) {
        console.error('Error reading config in delete:', e);
      }
    }

    // If the stream is live, we must stop FFmpeg FIRST so it releases the file lock on this video!
    if (isStreamLive && config) {
      console.log(`Live stream running. Stopping stream to release file lock on "${fileName}"...`);
      if (config.pid) {
        killProcess(config.pid);
        config.pid = null;
      }
      const child = (global as any).ffmpegProcess;
      if (child) {
        try { child.kill('SIGKILL'); } catch (e) { console.error('Error killing ffmpeg on delete:', e); }
        (global as any).ffmpegProcess = null;
      }
      // Wait a brief moment for the process to exit and release file locks
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Kill any active normalization process for this file
    const activeNormalizations = (global as any).activeNormalizations;
    const normalizationProcesses = (global as any).normalizationProcesses;
    if (normalizationProcesses && normalizationProcesses.has(fileName)) {
      console.log(`Killing active normalization process for deleted file "${fileName}"...`);
      const child = normalizationProcesses.get(fileName);
      if (child) {
        try { child.kill('SIGKILL'); } catch (e) { console.error('Error killing normalization:', e); }
      }
      normalizationProcesses.delete(fileName);
    }
    if (activeNormalizations) {
      activeNormalizations.delete(fileName);
    }

    const tempPath = filePath + '.tmp.mp4';
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }

    // Delete the file from disk
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Update config to remove file from playlist
    if (config) {
      if (Array.isArray(config.playlist)) {
        config.playlist = config.playlist.filter((name: string) => name !== fileName);
      }
      if (config.currentFile === fileName) {
        config.currentFile = '';
      }
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // If the stream was live, we restart it with the updated playlist
      if (isStreamLive) {
        if (config.playlist.length > 0) {
          console.log(`Restarting stream with the updated playlist...`);
          try {
            await startBroadcastHelper(config.streamKey, config);
          } catch (err) {
            console.error('Failed to restart stream after file deletion:', err);
          }
        } else {
          config.status = 'offline';
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      }
    }

    return NextResponse.json({ success: true, message: `File ${fileName} deleted` });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to delete file' }, { status: 500 });
  }
}
