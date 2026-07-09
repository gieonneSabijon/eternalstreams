import { exec, spawn, execSync } from 'child_process';
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
}

export function getCleanedFfmpegPath(): string {
  let ffmpegPath = ffmpegPathRaw || 'ffmpeg';
  if (ffmpegPathRaw) {
    const cleaned = ffmpegPathRaw.replace(/^\\ROOT|^ROOT|^\/ROOT/i, '');
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
    exec(`"${ffmpegPath}" -i "${filePath}"`, (err, stdout, stderr) => {
      const output = stderr || '';

      const resMatch = output.match(/,\s*(\d{3,5})x(\d{3,5})/);
      const width = resMatch ? parseInt(resMatch[1], 10) : null;
      const height = resMatch ? parseInt(resMatch[2], 10) : null;

      const fpsMatch = output.match(/,\s*(\d+(?:\.\d+)?)\s*fps/);
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

      const arMatch = output.match(/,\s*(\d+)\s*Hz/);
      const sampleRate = arMatch ? parseInt(arMatch[1], 10) : 44100;

      let channels = 2;
      if (output.includes('mono')) {
        channels = 1;
      } else if (output.includes('stereo')) {
        channels = 2;
      } else {
        const chanMatch = output.match(/,\s*(\d+)\s*channels/);
        if (chanMatch) {
          channels = parseInt(chanMatch[1], 10);
        }
      }

      const tbnMatch = output.match(/,\s*(\d+(?:\.\d+)?[kK]?)\s*tbn/);
      let tbn = 90000;
      if (tbnMatch) {
        const valStr = tbnMatch[1].toLowerCase();
        if (valStr.endsWith('k')) {
          tbn = Math.round(parseFloat(valStr.slice(0, -1)) * 1000);
        } else {
          tbn = Math.round(parseFloat(valStr));
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
          tbn
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
      current.tbn === target.tbn
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
  ffmpegPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scaleFilter = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const args = [
      '-y',
      '-i', filePath,
      '-vf', scaleFilter,
      '-r', target.fps.toString(),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '2500k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
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