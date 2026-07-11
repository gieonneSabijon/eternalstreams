import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getStorageSpace } from '@/lib/storage';

const uploadsDir = path.join(process.cwd(), 'uploads');
const configPath = path.join(process.cwd(), 'stream-config.json');

export async function GET() {
  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const allFiles = fs.readdirSync(uploadsDir);

    // Clean up temporary files older than 24 hours & count remaining ones
    const now = Date.now();
    const EXPIRATION_TIME = 24 * 60 * 60 * 1000;
    let tempCount = 0;
    let tempSize = 0;
    allFiles.forEach((fileName) => {
      if (fileName.startsWith('temp_') || fileName.endsWith('.tmp.mp4')) {
        const filePath = path.join(uploadsDir, fileName);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > EXPIRATION_TIME) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up expired temporary file: ${fileName}`);
          } else {
            tempCount++;
            tempSize += stats.size;
          }
        } catch (e) {
          // ignore
        }
      }
    });

    // Exclude temp files from library listing
    const files = allFiles.filter((fileName) => !fileName.startsWith('temp_') && !fileName.endsWith('.tmp.mp4'));
    
    // Read playlist config for custom ordering
    let playlist: string[] = [];
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData);
        playlist = config.playlist || [];
      } catch (err) {
        console.error('Failed to read config in files API:', err);
      }
    }

    const fileMap = new Map<string, number>();
    files.forEach((fileName) => {
      const filePath = path.join(uploadsDir, fileName);
      try {
        const stats = fs.statSync(filePath);
        fileMap.set(fileName, stats.size);
      } catch (e) {
        // Skip files that cannot be read
      }
    });

    // Sort files based on playlist order
    const sortedFileNames: string[] = [];
    
    // Add existing files in playlist order
    playlist.forEach((name) => {
      if (fileMap.has(name)) {
        sortedFileNames.push(name);
      }
    });

    // Add remaining files that were not in playlist
    const remaining = Array.from(fileMap.keys())
      .filter((name) => !sortedFileNames.includes(name))
      .sort((a, b) => a.localeCompare(b));

    sortedFileNames.push(...remaining);

    const fileList = sortedFileNames.map((fileName) => ({
      name: fileName,
      size: fileMap.get(fileName) || 0,
    }));

    const storage = await getStorageSpace();

    return NextResponse.json({
      files: fileList,
      storage,
      tempFiles: {
        count: tempCount,
        size: tempSize
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to list files' }, { status: 500 });
  }
}
