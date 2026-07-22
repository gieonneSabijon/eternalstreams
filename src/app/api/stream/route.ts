import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getFfmpegCommand, getFfmpegDiagnostics, getVideoConfig, isNormalized, normalizeVideo, killLingeringFfmpegProcesses, triggerNormalization, getReferenceVideoName, safeAppendToLog } from '@/lib/video';


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
      const defaultConfig = { status: 'offline', streamKey: '', playlist: [], pid: null, bitrate: 2500, preset: 'ultrafast' };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    const data = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(data);
    if (!parsed.playlist) {
      parsed.playlist = [];
    }
    if (!parsed.bitrate) {
      parsed.bitrate = 2500;
    }
    if (!parsed.preset) {
      parsed.preset = 'ultrafast';
    }
    return parsed;
  } catch (error) {
    console.error('Error reading config:', error);
    return { status: 'offline', streamKey: '', playlist: [], pid: null, bitrate: 2500, preset: 'ultrafast' };
  }
}

export function writeConfig(config: any) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error writing config:', error);
  }
}

export async function ensurePlaylistNormalized(config: any, uploadsDir: string, ffmpegPath: string): Promise<string[]> {
  let targetConfig = null;
  let referenceVideoName = await getReferenceVideoName(uploadsDir, config.playlist);
  let referenceVideoIndex = -1;

  if (referenceVideoName) {
    const videoPath = path.join(uploadsDir, referenceVideoName);
    try {
      if (fs.existsSync(videoPath)) {
        targetConfig = await getVideoConfig(videoPath, ffmpegPath);
        referenceVideoIndex = config.playlist.indexOf(referenceVideoName);
      }
    } catch (err: any) {
      console.error(`[Ensure] Mismatched/corrupt reference video "${referenceVideoName}":`, err.message);
    }
  }

  if (!targetConfig || !referenceVideoName) {
    return [];
  }

  let playlistModified = false;
  for (let i = referenceVideoIndex + 1; i < config.playlist.length; i++) {
    const file = config.playlist[i];
    const filePath = path.join(uploadsDir, file);
    try {
      if (!fs.existsSync(filePath)) continue;

      const current = await getVideoConfig(filePath, ffmpegPath);
      const fpsMatch = Math.abs(current.fps - targetConfig.fps) < 0.5;
      const isVideoH264 = current.codecVideo.includes('h264') || current.codecVideo.includes('avc');
      const isCompatible =
        current.width === targetConfig.width &&
        current.height === targetConfig.height &&
        fpsMatch &&
        isVideoH264;

      if (!isCompatible) {
        console.error(`[Sync/Check] Removing video "${file}" due to parameter/codec mismatch.`);

        const logFilePath = path.join(process.cwd(), 'ffmpeg_log.txt');
        try {
          fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] [Playlist ERROR] Video "${file}" removed from queue. Resolution/FPS (${current.width}x${current.height}, ${current.fps} fps, codec: ${current.codecVideo}) or codec does not match reference (${targetConfig.width}x${targetConfig.height}, ${targetConfig.fps} fps, codec: ${targetConfig.codecVideo}).\n`);
        } catch (logErr) {
          // ignore log write errors
        }

        config.playlist = config.playlist.filter((name: string) => name !== file);
        playlistModified = true;
        continue;
      }
    } catch (err) {
      console.error(`Error checking compatibility for ${file}:`, err);
    }
  }

  if (playlistModified) {
    writeConfig(config);
  }

  return [];
}

export async function startBroadcastHelper(streamKey: string, config: any) {
  const ffmpegPath = getFfmpegCommand();

  let targetConfig = null;
  let referenceVideoIndex = 0;

  while (referenceVideoIndex < config.playlist.length) {
    const videoName = config.playlist[referenceVideoIndex];
    const videoPath = path.join(uploadsDir, videoName);
    try {
      if (!fs.existsSync(videoPath)) {
        throw new Error('File does not exist on disk');
      }
      targetConfig = await getVideoConfig(videoPath, ffmpegPath);
      if (referenceVideoIndex > 0) {
        console.warn(`Skipped ${referenceVideoIndex} corrupt or missing video(s) at the start of the playlist.`);
        config.playlist = config.playlist.slice(referenceVideoIndex);
      }
      break;
    } catch (err: any) {
      console.error(`Skipping invalid/corrupt playlist video "${videoName}":`, err.message);
      if (fs.existsSync(videoPath)) {
        try { fs.unlinkSync(videoPath); } catch { }
      }
      referenceVideoIndex++;
    }
  }

  if (!targetConfig) {
    config.playlist = [];
    config.targetConfig = null;
    writeConfig(config);
    throw new Error("No valid videos in the playlist to start the broadcast.");
  }

  // Ensure the reference video itself is in standard track order (video at 0, audio at 1)
  if (targetConfig.videoStreamIndex !== 0 || targetConfig.audioStreamIndex !== 1) {
    console.log(`Reference video "${config.playlist[0]}" has non-standard track order. Normalizing to standard order...`);
    const referenceVideoPath = path.join(uploadsDir, config.playlist[0]);
    const tempPath = referenceVideoPath + '.tmp.mp4';
    const standardTargetConfig = {
      ...targetConfig,
      videoStreamIndex: 0,
      audioStreamIndex: 1
    };
    await normalizeVideo(referenceVideoPath, tempPath, standardTargetConfig, ffmpegPath, config.bitrate, config.preset);
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(referenceVideoPath);
      fs.renameSync(tempPath, referenceVideoPath);
      console.log(`Successfully normalized reference video to standard track order.`);
      targetConfig = await getVideoConfig(referenceVideoPath, ffmpegPath);
    }
  }

  config.targetConfig = targetConfig;
  writeConfig(config);

  // Check and normalize other playlist files to match targetConfig
  const updatedPlaylist = [config.playlist[0]];
  for (let i = 1; i < config.playlist.length; i++) {
    const file = config.playlist[i];
    const filePath = path.join(uploadsDir, file);
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error('File does not exist on disk');
      }
      const isNorm = await isNormalized(filePath, targetConfig, ffmpegPath);
      if (!isNorm) {
        console.log(`Normalizing playlist video "${file}" to match reference "${config.playlist[0]}" (${targetConfig.width}x${targetConfig.height}, ${targetConfig.fps}fps)`);
        const tempPath = filePath + '.tmp.mp4';
        await normalizeVideo(filePath, tempPath, targetConfig, ffmpegPath, config.bitrate, config.preset);
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(filePath);
          fs.renameSync(tempPath, filePath);
          console.log(`Successfully normalized "${file}"`);
        }
      }
      updatedPlaylist.push(file);
    } catch (err: any) {
      console.error(`Removing invalid/corrupt video "${file}" from playlist:`, err.message);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch { }
      }
    }
  }

  if (updatedPlaylist.length !== config.playlist.length) {
    config.playlist = updatedPlaylist;
    writeConfig(config);
  }

  // 🚀 FIX: Convert to absolute structural paths so Linux FFmpeg won't disconnect silently
  const playlistFilePath = path.join(process.cwd(), 'temp_playlist.txt');
  const playlistContent = [
    'ffconcat version 1.0',
    ...config.playlist.map((file: string) => {
      const absoluteVideoPath = path.join(uploadsDir, file).replace(/\\/g, '/');
      return `file '${absoluteVideoPath}'`;
    })
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

  // Kill any other lingering ffmpeg processes associated with this project
  killLingeringFfmpegProcesses();

  let streamUrl = streamKey.trim();
  if (!streamUrl.startsWith('rtmp://') && !streamUrl.startsWith('rtmps://')) {
    streamUrl = `rtmps://iad05.contribute.live-video.net/app/${streamUrl}`;
  }

  // Spawn real static ffmpeg process with global loops enabled
  const args = [
    '-err_detect', 'ignore_err',
    '-stream_loop', '-1',     // Tells FFmpeg to loop 
    '-re',
    '-fflags', '+genpts',
    '-f', 'concat',
    '-safe', '0',
    '-i', playlistFilePath,
    '-map', '0:v',
    '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', targetConfig.sampleRate.toString(),
    '-ac', targetConfig.channels.toString(),
    '-af', 'aresample=async=1',
    '-max_muxing_queue_size', '1024',
    '-flvflags no_duration_filesize',
    '-f', 'flv',
    streamUrl
  ];

  // Redirect stdout and stderr to a log file for debugging
  const logFilePath = path.join(process.cwd(), 'ffmpeg_log.txt');
  const safeStreamUrl = streamUrl.replace(/(app\/live_)[^/]+/, '$1******');

  const envDiagnostics = getFfmpegDiagnostics();
  const startDiagnostics = [
    `=== ETERNAL STREAM LAUNCH REPORT ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Platform: ${process.platform} (${process.arch})`,
    `Node version: ${process.version}`,
    `Execution Directory: ${process.cwd()}`,
    `Selected FFmpeg Command Path: ${ffmpegPath}`,
    `Playlist Config Path: ${playlistFilePath}`,
    `Playlist Config Content:`,
    playlistContent,
    `Resolved Target RTMP Endpoint: ${safeStreamUrl}`,
    `FFmpeg Command Arguments:`,
    JSON.stringify(args, null, 2),
    envDiagnostics,
    `Attempting to spawn FFmpeg process...`
  ].join('\n') + '\n\n';

  fs.writeFileSync(logFilePath, startDiagnostics);
  const logFd = fs.openSync(logFilePath, 'a');

  const child = spawn(ffmpegPath || 'ffmpeg', args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });

  fs.closeSync(logFd);

  child.unref();
  (global as any).ffmpegProcess = child;

  config.status = 'live';
  config.streamKey = streamKey.trim();
  config.pid = child.pid;
  writeConfig(config);

  child.on('exit', (code, signal) => {
    console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
    if ((global as any).ffmpegProcess === child) {
      (global as any).ffmpegProcess = null;
    }

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
      if (config.status === 'live' && !isProcessAlive(config.pid)) {
        config.status = 'offline';
        config.pid = null;
        writeConfig(config);
      }
      return NextResponse.json(config);
    } else if (action === 'save_key' || action === 'save_settings') {
      const { streamKey, bitrate, preset } = body;
      config.streamKey = (streamKey || '').trim();
      if (bitrate) config.bitrate = parseInt(bitrate, 10);
      if (preset) config.preset = preset;
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

      const missingFiles = config.playlist.filter((file: string) => !fs.existsSync(path.join(uploadsDir, file)));
      if (missingFiles.length > 0) {
        return NextResponse.json({ error: `Some playlist files are missing on server: ${missingFiles.join(', ')}` }, { status: 400 });
      }

      const ffmpegPath = getFfmpegCommand();
      const normalizingList = await ensurePlaylistNormalized(config, uploadsDir, ffmpegPath);
      if (normalizingList.length > 0) {
        return NextResponse.json({ error: `Some videos in the playlist need to be normalized to match the reference format: ${normalizingList.join(', ')}. Normalization has been started in the background. Please wait a moment and try again.` }, { status: 400 });
      }

      try {
        const updatedConfig = await startBroadcastHelper(streamKey, config);
        return NextResponse.json({ success: true, ...updatedConfig });
      } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
      }

    } else if (action === 'stop') {
      config.status = 'offline';

      if (config.pid) {
        killProcess(config.pid);
        config.pid = null;
      }
      writeConfig(config);

      const child = (global as any).ffmpegProcess;
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          console.error('Error killing ffmpeg:', e);
        }
        (global as any).ffmpegProcess = null;
      }

      // Also clean up any orphan processes matching the playlist
      killLingeringFfmpegProcesses();

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

        if (config.status === 'live') {
          const newFirstVideo = playlist[0];
          if (oldFirstVideo !== newFirstVideo) {
            console.log(`First video in playlist changed from "${oldFirstVideo}" to "${newFirstVideo}". Restarting live stream with new reference configuration...`);

            if (config.pid) {
              killProcess(config.pid);
              config.pid = null;
            }
            const child = (global as any).ffmpegProcess;
            if (child) {
              try { child.kill('SIGKILL'); } catch (e) { console.error('Error killing ffmpeg:', e); }
              (global as any).ffmpegProcess = null;
            }

            try {
              const updatedConfig = await startBroadcastHelper(config.streamKey, config);
              return NextResponse.json({ success: true, playlist: updatedConfig.playlist });
            } catch (err: any) {
              return NextResponse.json({ error: `Failed to restart stream with new first video: ${err.message}` }, { status: 500 });
            }
          } else {
            if (config.targetConfig) {
              const ffmpegPath = getFfmpegCommand();
              ensurePlaylistNormalized(config, uploadsDir, ffmpegPath); // Runs in background
            }

            // 🚀 FIX: Convert reorder content to absolute path lines as well
            const playlistFilePath = path.join(process.cwd(), 'temp_playlist.txt');
            const playlistContent = [
              'ffconcat version 1.0',
              ...playlist.map((file: string) => {
                const absoluteVideoPath = path.join(uploadsDir, file).replace(/\\/g, '/');
                return `file '${absoluteVideoPath}'`;
              })
            ].join('\n');

            fs.writeFileSync(playlistFilePath, playlistContent);
          }
        }

        return NextResponse.json({ success: true, playlist: config.playlist });
      } else {
        return NextResponse.json({ error: 'Playlist must be an array' }, { status: 400 });
      }
    } else if (action === 'sync') {
      try {
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const allFiles = fs.readdirSync(uploadsDir);
        const filesOnDisk = allFiles.filter((fileName) => !fileName.startsWith('temp_') && !fileName.endsWith('.tmp.mp4'));

        const oldPlaylist = config.playlist || [];
        const oldFirstVideo = oldPlaylist[0];

        // Filter out files that no longer exist on disk
        const updatedPlaylist = oldPlaylist.filter((file: string) => filesOnDisk.includes(file));

        // Add new files from disk that aren't in the playlist
        filesOnDisk.forEach((file) => {
          if (!updatedPlaylist.includes(file)) {
            updatedPlaylist.push(file);
          }
        });

        config.playlist = updatedPlaylist;

        // Reconcile targetConfig based on the first video in the updated playlist
        if (updatedPlaylist.length > 0) {
          const firstVideoName = updatedPlaylist[0];
          const firstVideoPath = path.join(uploadsDir, firstVideoName);
          const ffmpegPath = getFfmpegCommand();
          try {
            const targetConfig = await getVideoConfig(firstVideoPath, ffmpegPath);
            config.targetConfig = targetConfig;
          } catch (err: any) {
            console.error(`[Sync] Failed to read video config of the first video:`, err);
          }
        } else {
          // If playlist is empty, clear targetConfig
          config.targetConfig = null;
        }

        // Reconcile currentFile
        if (config.currentFile && !updatedPlaylist.includes(config.currentFile)) {
          config.currentFile = '';
        }

        // Reconcile process status and PID
        if (config.pid) {
          const alive = isProcessAlive(config.pid);
          if (!alive) {
            config.status = 'offline';
            config.pid = null;
          }
        } else {
          config.status = 'offline';
        }

        writeConfig(config);

        // If offline and there are playlist files, make sure we normalize them to reference config in background
        if (config.status !== 'live' && config.playlist.length > 0) {
          const ffmpegPath = getFfmpegCommand();
          ensurePlaylistNormalized(config, uploadsDir, ffmpegPath); // Runs in background
        }

        // If the stream is live, handle potential adjustments
        if (config.status === 'live' && updatedPlaylist.length > 0) {
          const newFirstVideo = updatedPlaylist[0];
          if (oldFirstVideo !== newFirstVideo) {
            console.log(`[Sync] First video in playlist changed from "${oldFirstVideo}" to "${newFirstVideo}". Restarting live stream...`);
            if (config.pid) {
              killProcess(config.pid);
              config.pid = null;
            }
            const child = (global as any).ffmpegProcess;
            if (child) {
              try { child.kill('SIGKILL'); } catch (e) { console.error('Error killing ffmpeg on sync restart:', e); }
              (global as any).ffmpegProcess = null;
            }
            try {
              const updatedConfig = await startBroadcastHelper(config.streamKey, config);
              return NextResponse.json({ success: true, playlist: updatedConfig.playlist, config: updatedConfig });
            } catch (err: any) {
              return NextResponse.json({ error: `Failed to restart stream with new first video after sync: ${err.message}` }, { status: 500 });
            }
          } else {
            // Check & normalize other files to match targetConfig
            if (config.targetConfig) {
              const ffmpegPath = getFfmpegCommand();
              ensurePlaylistNormalized(config, uploadsDir, ffmpegPath); // Runs in background
            }

            // Write playlist file
            const playlistFilePath = path.join(process.cwd(), 'temp_playlist.txt');
            const playlistContent = [
              'ffconcat version 1.0',
              ...updatedPlaylist.map((file: string) => {
                const absoluteVideoPath = path.join(uploadsDir, file).replace(/\\/g, '/');
                return `file '${absoluteVideoPath}'`;
              })
            ].join('\n');
            fs.writeFileSync(playlistFilePath, playlistContent);
          }
        } else if (config.status === 'live' && updatedPlaylist.length === 0) {
          // Live but no videos left
          config.status = 'offline';
          if (config.pid) {
            killProcess(config.pid);
            config.pid = null;
          }
          const child = (global as any).ffmpegProcess;
          if (child) {
            try { child.kill('SIGKILL'); } catch (e) { console.error('Error killing ffmpeg on empty sync:', e); }
            (global as any).ffmpegProcess = null;
          }
          writeConfig(config);
        }

        return NextResponse.json({ success: true, playlist: config.playlist, config });
      } catch (err: any) {
        return NextResponse.json({ error: `Sync failed: ${err.message}` }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}