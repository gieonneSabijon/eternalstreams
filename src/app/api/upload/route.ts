import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getFfmpegCommand, normalizeVideo } from '@/lib/video';

const uploadsDir = path.join(process.cwd(), 'uploads');
const configPath = path.join(process.cwd(), 'stream-config.json');

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name;

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filePath = path.join(uploadsDir, fileName);
    fs.writeFileSync(filePath, buffer);

    // If live stream is running, dynamically normalize the uploaded file to match the stream configuration
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData);
        if (config.status === 'live' && config.targetConfig) {
          const ffmpegPath = getFfmpegCommand();
          console.log(`Live stream running. Dynamically normalizing uploaded file "${fileName}" to match targetConfig (${config.targetConfig.width}x${config.targetConfig.height}, ${config.targetConfig.fps}fps)`);
          const tempPath = filePath + '.tmp.mp4';
          await normalizeVideo(filePath, tempPath, config.targetConfig, ffmpegPath);
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(filePath);
            fs.renameSync(tempPath, filePath);
            console.log(`Successfully normalized uploaded file: ${fileName}`);
          }
        }
      } catch (err) {
        console.error('Failed to normalize uploaded file dynamically against running stream:', err);
      }
    }

    // 🚀 AUTOMATICALLY UPDATE CONFIG ON SUCCESSFUL UPLOAD
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData);

        if (!Array.isArray(config.playlist)) {
          config.playlist = [];
        }

        // Only append if it's not already tracked in the playlist array
        if (!config.playlist.includes(fileName)) {
          config.playlist.push(fileName);
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      } catch (configErr) {
        console.error('Failed to update config during upload sync:', configErr);
      }
    }

    return NextResponse.json({ success: true, name: fileName, size: file.size });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 });
  }
}