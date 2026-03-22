'use server';

import { generateVideo, pollVideoStatus, VideoGenerationOptions } from '@/lib/xai';

export async function generateVideoAction(formData: FormData) {
  try {
    const file = formData.get('image') as File;
    const prompt = formData.get('prompt') as string;
    const duration = parseInt(formData.get('duration') as string || '1');
    const resolution = formData.get('resolution') as string || '720p';
    const aspectRatio = formData.get('aspect_ratio') as string || '16:9';

    if (!file || !prompt) {
      throw new Error('Image and prompt are required');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64Image = `data:${file.type};base64,${buffer.toString('base64')}`;

    const options: VideoGenerationOptions = {
      duration,
      resolution,
      aspect_ratio: aspectRatio,
    };

    const { id } = await generateVideo(base64Image, prompt, options);
    return { success: true, id };
  } catch (error: any) {
    console.error('Generation Error:', error);
    return { success: false, error: error.message };
  }
}

export async function checkStatusAction(id: string) {
  try {
    const status = await pollVideoStatus(id);
    return { success: true, data: status };
  } catch (error: any) {
    console.error('Polling Error:', error);
    return { success: false, error: error.message };
  }
}
