import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const uploadsDir = path.join(process.cwd(), 'uploads');
const configPath = path.join(process.cwd(), 'stream-config.json');

export async function POST(request: Request) {
  return handleRename(request);
}

export async function PUT(request: Request) {
  return handleRename(request);
}

async function handleRename(request: Request) {
  try {
    const body = await request.json();
    const { oldName, newName } = body;

    if (!oldName || !newName) {
      return NextResponse.json({ error: 'Both oldName and newName parameters are required' }, { status: 400 });
    }

    const oldPath = path.join(uploadsDir, oldName);
    const newPath = path.join(uploadsDir, newName);

    // Path traversal check
    const resolvedOld = path.resolve(oldPath);
    const resolvedNew = path.resolve(newPath);
    if (!resolvedOld.startsWith(uploadsDir) || !resolvedNew.startsWith(uploadsDir)) {
      return NextResponse.json({ error: 'Unauthorized access path' }, { status: 403 });
    }

    if (!fs.existsSync(oldPath)) {
      return NextResponse.json({ error: 'Source file not found' }, { status: 404 });
    }

    const activeNormalizations = (global as any).activeNormalizations;
    if (activeNormalizations && activeNormalizations.has(oldName)) {
      return NextResponse.json({ error: 'Cannot rename file while it is being normalized. Please wait for normalization to complete.' }, { status: 409 });
    }

    if (fs.existsSync(newPath)) {
      return NextResponse.json({ error: 'A file with the new name already exists' }, { status: 409 });
    }

    fs.renameSync(oldPath, newPath);

    // Update active stream file and playlist in the config
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData);
      
      if (Array.isArray(config.playlist)) {
        config.playlist = config.playlist.map((name: string) => name === oldName ? newName : name);
      }
      if (config.currentFile === oldName) {
        config.currentFile = newName;
      }
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    return NextResponse.json({ success: true, message: `File renamed to ${newName}` });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to rename file' }, { status: 500 });
  }
}
