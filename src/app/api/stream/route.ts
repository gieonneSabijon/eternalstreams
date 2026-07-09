import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getFfmpegCommand, getVideoConfig, isNormalized, normalizeVideo } from '@/lib/video';

const configPath = path.join(process.cwd(), 'stream-config.json');
const uploadsDir = path.join(process.cwd(), 'uploads');

export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

export function killProcess(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (e) {
    console.error(`Error killing process ${pid}:`, e);
    return false;
  }
}

export function readConfig() {
  try {
    if (!fs.existsSync(configPath)) {
      const defaultConfig = { status: 'offline', streamKey: '', playlist: [], pid: null };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    const data = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(data);
    if (!parsed.playlist) {
      parsed.playlist = [];
    }
    return parsed;
  } catch (error) {
    console.error('Error reading config:', error);
    return { status: 'offline', streamKey: '', playlist: [], pid: null };
  }
}

export function writeConfig(config: any) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error writing config:', error);
  }
}

export async function startBroadcastHelper(streamKey: string, config: any) {
  const ffmpegPath = getFfmpegCommand();

  // Get reference video config from the first item in the playlist
  const firstVideoName = config.playlist[0];
  const firstVideoPath = path.join(uploadsDir, firstVideoName);
  let targetConfig;
  try {
    targetConfig = await getVideoConfig(firstVideoPath, ffmpegPath);
    // Save targetConfig to the config file so it's persisted for the running stream
    config.targetConfig = targetConfig;
    writeConfig(config);
  } catch (err: any) {
    throw new Error(`Failed to read configuration of the first video (${firstVideoName}): ${err.message}`);
  }

  // Check and normalize other playlist files to match targetConfig
  for (let i = 1; i < config.playlist.length; i++) {
    const file = config.playlist[i];
    const filePath = path.join(uploadsDir, file);
    try {
      const isNorm = await isNormalized(filePath, targetConfig, ffmpegPath);
      if (!isNorm) {
        console.log(`Normalizing playlist video "${file}" to match reference "${firstVideoName}" (${targetConfig.width}x${targetConfig.height}, ${targetConfig.fps}fps)`);
        const tempPath = filePath + '.tmp.mp4';
        await normalizeVideo(filePath, tempPath, targetConfig, ffmpegPath);
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(filePath);
          fs.renameSync(tempPath, filePath);
          console.log(`Successfully normalized "${file}"`);
        }
      }
    } catch (err: any) {
      console.error(`Failed to normalize "${file}":`, err);
      throw new Error(`Failed to normalize playlist video "${file}" to match reference config: ${err.message}`);
    }
  }

  // Create ffmpeg concat playlist file (self-referencing to loop the entire list infinitely using relative paths)
  const playlistFilePath = path.join(process.cwd(), 'temp_playlist.txt');
  const playlistContent = [
    'ffconcat version 1.0',
    ...config.playlist.map((file: string) => `file 'uploads/${file}'`),
    `file 'temp_playlist.txt'`
  ].join('\n');

  fs.writeFileSync(playlistFilePath, playlistContent);

  // Kill any active ffmpeg session by PID first
  if (config.pid && isProcessAlive(config.pid)) {
    killProcess(config.pid);
  }

  // Kill any active ffmpeg session by global variable (fallback)
  const existingChild = (global as any).ffmpegProcess;
  if (existingChild) {
    try {
      existingChild.kill('SIGKILL');
    } catch (e) {
      console.error(e);
    }
    (global as any).ffmpegProcess = null;
  }

  // Ingest endpoint: If a full rtmp:// or rtmps:// URL is provided in the streamKey input, use it directly.
  // Otherwise, default to Twitch standard RTMP (highly compatible with VPS and system ffmpeg builds).
  let streamUrl = streamKey.trim();
  if (!streamUrl.startsWith('rtmp://') && !streamUrl.startsWith('rtmps://')) {
    streamUrl = `rtmp://ingest.global-contribute.live-video.net/app/${streamUrl}`;
  }

  // Spawn real static ffmpeg process
  const args = [
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-i', playlistFilePath,
    '-c:v', 'libx264',
    '-preset', 'superfast', // optimized CPU encoding
    '-tune', 'zerolatency',
    '-threads', '0',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    streamUrl
  ];

  // Redirect stdout and stderr to a log file for debugging
  const logFilePath = path.join(process.cwd(), 'ffmpeg_log.txt');
  fs.writeFileSync(logFilePath, `--- Stream starting at ${new Date().toISOString()} ---\n`);
  const logFd = fs.openSync(logFilePath, 'a');

  const child = spawn(ffmpegPath || 'ffmpeg', args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });

  fs.closeSync(logFd);

  child.unref();
  (global as any).ffmpegProcess = child;

  // Update config with status, streamKey and new PID
  config.status = 'live';
  config.streamKey = streamKey.trim();
  config.pid = child.pid;
  writeConfig(config);

  // Handle child process exit
  child.on('exit', (code, signal) => {
    console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
    if ((global as any).ffmpegProcess === child) {
      (global as any).ffmpegProcess = null;
    }

    // Re-read config, if the PID matches, set status back to offline
    const latestConfig = readConfig();
    if (latestConfig.pid === child.pid) {
      latestConfig.status = 'offline';
      latestConfig.pid = null;
      writeConfig(latestConfig);
    }
  });

  child.on('error', (err) => {
    console.error('FFmpeg process launch error:', err);
    try {
      fs.appendFileSync(logFilePath, `FFmpeg process launch CRITICAL error: ${err.message}\n`);
    } catch (logErr) {
      console.error('Failed to write spawn error to log file:', logErr);
    }

    // Reset stream status since launch failed
    const latestConfig = readConfig();
    if (latestConfig.pid === child.pid) {
      latestConfig.status = 'offline';
      latestConfig.pid = null;
      writeConfig(latestConfig);
    }
  });

  return config;
}

export async function GET() {
  const config = readConfig();
  // Sync status
  if (config.status === 'live' && !isProcessAlive(config.pid)) {
    config.status = 'offline';
    config.pid = null;
    writeConfig(config);
  }
  return NextResponse.json(config);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    const config = readConfig();

    if (action === 'status') {
      // Sync status
      if (config.status === 'live' && !isProcessAlive(config.pid)) {
        config.status = 'offline';
        config.pid = null;
        writeConfig(config);
      }
      return NextResponse.json(config);
    } else if (action === 'save_key') {
      const { streamKey } = body;
      config.streamKey = (streamKey || '').trim();
      writeConfig(config);
      return NextResponse.json({ success: true, ...config });
    } else if (action === 'start') {
      const { streamKey } = body;
      if (!streamKey || !streamKey.trim()) {
        return NextResponse.json({ error: 'Twitch Stream Security Key is required to broadcast.' }, { status: 400 });
      }
      if (!config.playlist || config.playlist.length === 0) {
        return NextResponse.json({ error: 'You must upload at least one video loop to start.' }, { status: 400 });
      }

      // Check if all files in playlist actually exist in uploads/
      const missingFiles = config.playlist.filter((file: string) => !fs.existsSync(path.join(uploadsDir, file)));
      if (missingFiles.length > 0) {
        return NextResponse.json({ error: `Some playlist files are missing on server: ${missingFiles.join(', ')}` }, { status: 400 });
      }

      try {
        const updatedConfig = await startBroadcastHelper(streamKey, config);
        return NextResponse.json({ success: true, ...updatedConfig });
      } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
      }

    } else if (action === 'stop') {
      config.status = 'offline';

      // Kill the running ffmpeg process by PID
      if (config.pid) {
        killProcess(config.pid);
        config.pid = null;
      }
      writeConfig(config);

      // Kill the running ffmpeg process by global variable (fallback)
      const child = (global as any).ffmpegProcess;
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          console.error('Error killing ffmpeg:', e);
        }
        (global as any).ffmpegProcess = null;
      }

      return NextResponse.json({ success: true, ...config });

    } else if (action === 'reorder') {
      const { playlist } = body;
      if (Array.isArray(playlist)) {
        if (playlist.length === 0) {
          return NextResponse.json({ error: 'Playlist cannot be empty' }, { status: 400 });
        }
        
        const oldFirstVideo = config.playlist[0];
        config.playlist = playlist;
        writeConfig(config);

        // If currently live, check if the reference first video has changed
        if (config.status === 'live') {
          const newFirstVideo = playlist[0];
          if (oldFirstVideo !== newFirstVideo) {
            console.log(`First video in playlist changed from "${oldFirstVideo}" to "${newFirstVideo}". Restarting live stream with new reference configuration...`);
            
            // Stop current stream first
            if (config.pid) {
              killProcess(config.pid);
              config.pid = null;
            }
            const child = (global as any).ffmpegProcess;
            if (child) {
              try { child.kill('SIGKILL'); } catch (e) { console.error('Error killing ffmpeg:', e); }
              (global as any).ffmpegProcess = null;
            }

            // Restart live stream with the new config!
            try {
              const updatedConfig = await startBroadcastHelper(config.streamKey, config);
              return NextResponse.json({ success: true, playlist: updatedConfig.playlist });
            } catch (err: any) {
              return NextResponse.json({ error: `Failed to restart stream with new first video: ${err.message}` }, { status: 500 });
            }
          } else {
            // Reference video is the same. Just dynamically normalize any other videos that don't match the current targetConfig.
            if (config.targetConfig) {
              const ffmpegPath = getFfmpegCommand();
              for (const file of playlist) {
                const filePath = path.join(uploadsDir, file);
                try {
                  const isNorm = await isNormalized(filePath, config.targetConfig, ffmpegPath);
                  if (!isNorm) {
                     console.log(`Dynamic normalization: Normalizing reordered video "${file}" to match live targetConfig (${config.targetConfig.width}x${config.targetConfig.height}, ${config.targetConfig.fps}fps)`);
                     const tempPath = filePath + '.tmp.mp4';
                     await normalizeVideo(filePath, tempPath, config.targetConfig, ffmpegPath);
                     if (fs.existsSync(tempPath)) {
                       fs.unlinkSync(filePath);
                       fs.renameSync(tempPath, filePath);
                       console.log(`Successfully normalized "${file}"`);
                     }
                  }
                } catch (err) {
                  console.error(`Failed to dynamically normalize reordered file "${file}":`, err);
                }
              }
            }

            const playlistFilePath = path.join(process.cwd(), 'temp_playlist.txt');
            const playlistContent = [
              'ffconcat version 1.0',
              ...playlist.map((file: string) => `file 'uploads/${file}'`),
              `file 'temp_playlist.txt'` // 🚀 Restore the loop mechanics!
            ].join('\n');

            fs.writeFileSync(playlistFilePath, playlistContent);
          }
        }

        return NextResponse.json({ success: true, playlist: config.playlist });
      } else {
        return NextResponse.json({ error: 'Playlist must be an array' }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
