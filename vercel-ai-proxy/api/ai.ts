// @ts-ignore
import { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { originalName, concept } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    res.status(500).json({ error: 'Gemini API key not set' });
    return;
  }
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const prompt = `
    사용자의 영문 이름: ${originalName}
    아이돌 콘셉트: ${concept}
    ---
    위 정보를 바탕으로 K-POP 스타일의 세련된 한국 이름 3개를 추천해줘.
    각 이름에 대해:
    - 한글 이름
    - 한자(가능하다면)
    - 의미(간단하게)
    - 콘셉트 설명(아이돌 캐치프레이즈처럼)
    결과는 JSON 배열로 반환해줘. 예시:
    [
      {"name": "세아", "hanja": "世芽", "meaning": "세상에 움튼 새싹", "concept": "신비로운 소녀"},
      ...
    ]
  `;
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  let results;
  try {
    results = JSON.parse(text);
  } catch (e) {
    res.status(500).json({ error: 'AI 응답 파싱 실패', raw: text });
    return;
  }
  res.status(200).json({ results });
}
