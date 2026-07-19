import { exec, spawn, execSync, execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
// @ts-ignore
import ffmpegPathRaw from 'ffmpeg-static';

const execPromise = util.promisify(exec);

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
  tbn: number;
  videoStreamIndex: number;
  audioStreamIndex: number;
}

export function getCleanedFfmpegPath(): string {
  let ffmpegPath = ffmpegPathRaw || 'ffmpeg';
  if (ffmpegPathRaw) {
    if (fs.existsSync(ffmpegPathRaw)) {
      return ffmpegPathRaw;
    }
    const cleaned = ffmpegPathRaw.replace(/^\\ROOT|^ROOT|^\/ROOT/, '');
    const relativePath = cleaned.startsWith('/') || cleaned.startsWith('\\') ? cleaned.slice(1) : cleaned;
    ffmpegPath = path.resolve(process.cwd(), relativePath);
  }
  return ffmpegPath;
}

export function getFfmpegCommand(): string {
  // If running on the Linux VPS, use the native system FFmpeg binary immediately.
  // This bypasses static build network engine deadlocks on virtual hosting environments.
  if (process.platform === 'linux') {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return 'ffmpeg';
    } catch (err) {
      console.warn('System ffmpeg command check failed on Linux, falling back to static binary config...', err);
    }
  }

  const staticPath = getCleanedFfmpegPath();

  // 2. Local fallback / Windows environment strategy: Try static path first
  try {
    if (fs.existsSync(staticPath)) {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(staticPath, 0o755);
        } catch (chmodErr) {
          console.warn(`Failed to chmod static ffmpeg binary:`, chmodErr);
        }
      }
      execSync(`"${staticPath}" -version`, { stdio: 'ignore' });
      return staticPath;
    }
  } catch (err) {
    console.warn(`Static FFmpeg binary failed execution check:`, err);
  }

  // 3. Absolute Fallback to system command if it hasn't been checked yet
  if (process.platform !== 'linux') {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return 'ffmpeg';
    } catch (err) {
      console.error('System ffmpeg command not found or failed check.');
    }
  }

  return staticPath;
}

export function getFfmpegDiagnostics(): string {
  const staticPath = getCleanedFfmpegPath();
  let log = `=== FFmpeg Environment Diagnostics ===\n`;
  log += `- Static binary path: ${staticPath}\n`;
  log += `- Static binary exists: ${fs.existsSync(staticPath)}\n`;

  if (fs.existsSync(staticPath)) {
    try {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(staticPath, 0o755); } catch { }
      }
      const output = execSync(`"${staticPath}" -version`, { encoding: 'utf-8', timeout: 3000 });
      log += `- Static binary run check: SUCCESS\n  Version header: ${output.split('\n')[0].trim()}\n`;
    } catch (err: any) {
      log += `- Static binary run check: FAILED. Error: ${err.message}\n`;
    }
  }

  try {
    const output = execSync('ffmpeg -version', { encoding: 'utf-8', timeout: 3000 });
    log += `- System 'ffmpeg' check: SUCCESS\n  Version header: ${output.split('\n')[0].trim()}\n`;
  } catch (err: any) {
    log += `- System 'ffmpeg' check: FAILED. Error: ${err.message}\n`;
  }

  log += `======================================\n`;
  return log;
}

export function getVideoConfig(filePath: string, ffmpegPath: string): Promise<VideoConfig> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (err, stdout, stderr) => {
      const output = stderr || '';
      const lines = output.split('\n');

      const videoLine = lines.find(line => line.includes('Stream #') && line.includes('Video:'));
      const audioLine = lines.find(line => line.includes('Stream #') && line.includes('Audio:'));

      let width = null;
      let height = null;
      let fps = 30;
      let tbn = 90000;
      let videoStreamIndex = 0;
      let audioStreamIndex = 1;

      if (videoLine) {
        const streamMatch = videoLine.match(/Stream #\d+:(\d+)/);
        if (streamMatch) {
          videoStreamIndex = parseInt(streamMatch[1], 10);
        }

        const resMatch = videoLine.match(/,\s*(\d{3,5})x(\d{3,5})/);
        width = resMatch ? parseInt(resMatch[1], 10) : null;
        height = resMatch ? parseInt(resMatch[2], 10) : null;

        const fpsMatch = videoLine.match(/,\s*(\d+(?:\.\d+)?)\s*fps/);
        fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

        const tbnMatch = videoLine.match(/,\s*(\d+(?:\.\d+)?[kK]?)\s*tbn/);
        if (tbnMatch) {
          const valStr = tbnMatch[1].toLowerCase();
          if (valStr.endsWith('k')) {
            tbn = Math.round(parseFloat(valStr.slice(0, -1)) * 1000);
          } else {
            tbn = Math.round(parseFloat(valStr));
          }
        }
      }

      let sampleRate = 44100;
      let channels = 2;

      if (audioLine) {
        const streamMatch = audioLine.match(/Stream #\d+:(\d+)/);
        if (streamMatch) {
          audioStreamIndex = parseInt(streamMatch[1], 10);
        }

        const arMatch = audioLine.match(/,\s*(\d+)\s*Hz/);
        sampleRate = arMatch ? parseInt(arMatch[1], 10) : 44100;

        if (audioLine.includes('mono')) {
          channels = 1;
        } else if (audioLine.includes('stereo')) {
          channels = 2;
        } else {
          const chanMatch = audioLine.match(/,\s*(\d+)\s*channels/);
          if (chanMatch) {
            channels = parseInt(chanMatch[1], 10);
          }
        }
      }

      if (!width || !height) {
        reject(new Error(`Could not parse video resolution for ${path.basename(filePath)}. Output: ${output.slice(0, 500)}`));
      } else {
        resolve({
          width,
          height,
          fps,
          sampleRate,
          channels,
          tbn,
          videoStreamIndex,
          audioStreamIndex
        });
      }
    });
  });
}

export async function isNormalized(filePath: string, target: VideoConfig, ffmpegPath: string): Promise<boolean> {
  try {
    const current = await getVideoConfig(filePath, ffmpegPath);
    const fpsMatch = Math.abs(current.fps - target.fps) < 0.5;
    return (
      current.width === target.width &&
      current.height === target.height &&
      fpsMatch &&
      current.sampleRate === target.sampleRate &&
      current.channels === target.channels &&
      current.tbn === target.tbn &&
      current.videoStreamIndex === target.videoStreamIndex &&
      current.audioStreamIndex === target.audioStreamIndex
    );
  } catch (err) {
    console.error(`Error checking normalization for ${filePath}:`, err);
    return false;
  }
}

export function normalizeVideo(
  filePath: string,
  tempPath: string,
  target: VideoConfig,
  ffmpegPath: string,
  bitrate?: number,
  preset?: string
): Promise<void> {
  const finalBitrate = bitrate ? `${bitrate}k` : '2500k';
  const finalBufsize = bitrate ? `${bitrate * 2}k` : '5000k';
  const finalPreset = preset || 'ultrafast';

  return new Promise((resolve, reject) => {
    const scaleFilter = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const args = [
      '-y',
      '-i', filePath,
      '-vf', scaleFilter,
      '-r', target.fps.toString(),
      '-c:v', 'libx264',
      '-preset', finalPreset,
      '-threads', '2',
      '-b:v', finalBitrate,
      '-maxrate', finalBitrate,
      '-bufsize', finalBufsize,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', target.sampleRate.toString(),
      '-ac', target.channels.toString(),
      '-video_track_timescale', target.tbn.toString(),
      tempPath
    ];

    const child = spawn(ffmpegPath, args);
    let stderr = '';

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}. Stderr: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export function killLingeringFfmpegProcesses() {
  const playlistName = 'temp_playlist.txt';
  try {
    if (process.platform === 'win32') {
      // Find and kill processes on Windows with temp_playlist.txt in their command line
      const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'ffmpeg.exe'\\" | Where-Object { $_.CommandLine -like '*${playlistName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;
      try {
        execSync(psCommand, { stdio: 'ignore' });
      } catch (err: any) {
        console.warn('PowerShell process cleanup failed, attempting taskkill fallback...', err.message);
        try {
          execSync('taskkill /F /IM ffmpeg.exe', { stdio: 'ignore' });
        } catch (tkErr) {
          // ignore
        }
      }
    } else {
      // Find and kill processes on Linux/macOS
      // Use pkill -9 -f to find processes with 'temp_playlist.txt' in their command line
      try {
        execSync(`pkill -9 -f "${playlistName}"`, { stdio: 'ignore' });
      } catch (err) {
        // pkill exits with 1 if no process matched, which is normal and expected
      }
    }
  } catch (err: any) {
    console.error('Error in killLingeringFfmpegProcesses:', err.message);
  }
}