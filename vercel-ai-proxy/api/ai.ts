// @ts-ignore
import { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// Firebase Admin 초기화 (중복 방지)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const auth = getAuth();
const db = getFirestore();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS 헤더 설정 - 더 포괄적으로 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  // OPTIONS 요청 처리 (preflight) - 더 명확하게
  if (req.method === 'OPTIONS') {
    res.status(200).json({ message: 'OK' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 웹 환경에서는 Firebase Auth 토큰 검증을 건너뛰고 기본 UID 사용
  let uid = 'web-user';
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  
  if (idToken) {
    try {
      const decoded = await auth.verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      // 토큰이 유효하지 않아도 웹에서는 계속 진행
      console.log('Invalid token, using default UID for web');
    }
  }

  // 2. Rate Limit 체크 (1분 2회, 하루 10회)
  const now = Timestamp.now();
  const oneMinuteAgo = Timestamp.fromMillis(now.toMillis() - 60 * 1000);
  const todayStart = Timestamp.fromDate(new Date(
    now.toDate().getFullYear(),
    now.toDate().getMonth(),
    now.toDate().getDate(), 0, 0, 0, 0
  ));
  const rateDocRef = db.collection('rate_limits').doc(uid);
  const rateDoc = await rateDocRef.get();
  let lastCalls = rateDoc.exists ? rateDoc.data().lastCalls || [] : [];
  // Firestore Timestamp 객체로 변환 (혹시 string일 경우)
  lastCalls = lastCalls.map((ts: any) =>
    ts instanceof Timestamp ? ts : Timestamp.fromMillis(new Date(ts).getTime())
  );
  lastCalls = lastCalls.filter((ts: Timestamp) => ts.toMillis() > todayStart.toMillis());
  const callsInLastMinute = lastCalls.filter((ts: Timestamp) => ts.toMillis() > oneMinuteAgo.toMillis()).length;
  const callsToday = lastCalls.length;
  if (callsInLastMinute >= 3) {
    res.status(429).json({ error: '1분에 3회까지만 요청할 수 있습니다.' });
    return;
  }
  if (callsToday >= 10) {
    res.status(429).json({ error: '하루에 10회까지만 요청할 수 있습니다.' });
    return;
  }
  // 호출 기록 갱신
  lastCalls.push(now);
  await rateDocRef.set({ lastCalls }, { merge: true });

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
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  let results;
  try {
    // 1. ```json ... ``` 코드블록만 추출
    const match = text.match(/```json\s*([\s\S]*?)```/);
    let jsonString;
    if (match) {
      jsonString = match[1];
    } else {
      // fallback: 그냥 전체에서 첫 번째 [ ... ] 추출
      const arrMatch = text.match(/\[\s*{[\s\S]*}\s*\]/);
      jsonString = arrMatch ? arrMatch[0] : text;
    }
    results = JSON.parse(jsonString);
  } catch (e) {
    res.status(500).json({ error: 'AI 응답 파싱 실패', raw: text });
    return;
  }
  res.status(200).json({ results });
}