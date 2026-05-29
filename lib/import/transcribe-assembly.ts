import 'server-only';

import { AssemblyAI } from 'assemblyai';

export type TranscribeResult = {
  transcript: string;
};

function getClient(): AssemblyAI {
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('未配置 ASSEMBLYAI_API_KEY');
  }
  return new AssemblyAI({ apiKey });
}

/**
 * 通过公网视频 URL 转写（抖音 play_url）
 * @see https://www.assemblyai.com/docs
 */
export async function transcribeFromVideoUrl(
  videoUrl: string,
): Promise<TranscribeResult> {
  const client = getClient();

  const transcript = await client.transcripts.transcribe({
    audio_url: videoUrl,
    speech_models: ['universal-2'],
    language_code: 'zh',
    speaker_labels: true,
  });

  if (transcript.status === 'error') {
    throw new Error(transcript.error || 'AssemblyAI 转写失败');
  }

  const text = transcript.text?.trim();
  if (!text) {
    throw new Error('转写结果为空');
  }

  return { transcript: text };
}
