// FILE: scripts/publish-firestore-to-public.mjs
//
// ✅ 요구사항 그대로:
// 1) Firestore(exhibitions, lectures) -> OUT_DIR/exhibitions.json (최신 고정 파일명)
// 2) "기존 영구 데이터"는 유지 + 누적 (id 기준 merge)
// 3) 발행 성공 후 Firestore 컬렉션은 "싹 비우기" (delete)
// 4) dated 스냅샷도 저장: OUT_DIR/exhibitions-YYYYMMDD.json
//
// NOTE:
// - merge 정책: 같은 id면 최신(Firestore) 값이 기존을 덮어씀
// - deleted:true 문서는 정본에서 제거(완전 삭제)

import admin from "firebase-admin";
import fs from "fs";
import path from "path";

/* =========================
 * 기본 유틸
 * ========================= */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function getKstStamp() {
  const now = new Date();
  const kst = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
  return `${kst.getFullYear()}${pad2(kst.getMonth() + 1)}${pad2(
    kst.getDate()
  )}`;
}

// Timestamp 직렬화(ISO 문자열로)
function jsonReplacer(_k, v) {
  if (v && typeof v === "object") {
    if (v._seconds != null && v._nanoseconds != null) {
      const ms = v._seconds * 1000 + Math.floor(v._nanoseconds / 1e6);
      return new Date(ms).toISOString();
    }
    if (v instanceof Date) return v.toISOString();
  }
  return v;
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function dumpCollection(db, name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// 컬렉션 문서 전부 삭제(500개 단위 배치)
async function deleteCollection(db, name) {
  const colRef = db.collection(name);

  while (true) {
    const snap = await colRef.limit(500).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

/**
 * id 기준 MERGE
 */
function mergeById(baseArr, nextArr) {
  const map = new Map();

  (Array.isArray(baseArr) ? baseArr : []).forEach((x) => {
    if (x && x.id) map.set(x.id, { ...x });
  });

  (Array.isArray(nextArr) ? nextArr : []).forEach((x) => {
    if (!x || !x.id) return;

    if (x.deleted === true) {
      map.delete(x.id);
      return;
    }

    const prev = map.get(x.id) || {};
    map.set(x.id, { ...prev, ...x, id: x.id });
  });

  return Array.from(map.values());
}

/* =========================
 * 메인
 * ========================= */
async function main() {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT secret.");

  const serviceAccount = JSON.parse(saRaw);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  const db = admin.firestore();

  const collections = ["exhibitions", "lectures"];
  const stamp = getKstStamp();

  // ✅ 출력 경로 결정
  // 워크플로우에서 OUT_DIR=website/data 지정
  const OUT_DIR = process.env.OUT_DIR || path.join("public", "data");
  ensureDir(OUT_DIR);

  const latestPath = path.join(OUT_DIR, "exhibitions.json");
  const datedPath = path.join(OUT_DIR, `exhibitions-${stamp}.json`);

  // ✅ 기존 정본 로드
  const prev = safeReadJson(latestPath);
  const prevData =
    prev?.data && typeof prev.data === "object" ? prev.data : {};

  // ✅ Firestore 스냅샷
  const currentData = {};
  for (const c of collections) {
    currentData[c] = await dumpCollection(db, c);
  }

  // ✅ MERGE
  const merged = {};
  for (const c of collections) {
    merged[c] = mergeById(prevData[c] || [], currentData[c] || []);
  }

  const payload = {
    meta: {
      timezone: "Asia/Seoul",
      publishedAt: new Date().toISOString(),
      stampKST: stamp,
      collections,
      mode: "merge-by-id",
    },
    data: merged,
  };

  // ✅ 파일 발행
  const json = JSON.stringify(payload, jsonReplacer, 2);
  fs.writeFileSync(latestPath, json, "utf8");
  fs.writeFileSync(datedPath, json, "utf8");

  console.log("Wrote:", latestPath);
  console.log("Wrote:", datedPath);

  // ✅ Firestore 비우기
  for (const c of collections) {
    await deleteCollection(db, c);
    console.log("Cleared collection:", c);
  }

  console.log("Publish complete (merge) + Firestore cleared.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
