# Sea Scout API v1 — ระบบสมาชิกกลาง (r14.15.59–60)

ใช้ร่วมกันทั้ง Android, iOS และ SeaScout_Admin.html — อยู่ใน Worker เดิม `seascout` ที่ `/api/v1/*`
ของเดิมไม่เปลี่ยน: หน้าแอป/ไฟล์ข้อมูล (assets) และ `/api/crash`

## สถานะการเปิดใช้งาน
- โค้ดอยู่ใน `worker/api/`, ฐานข้อมูลใน `migrations/0001_membership.sql`
- **ยังไม่มีฐานข้อมูล D1 ผูกกับ Worker** → `/api/v1/health` ตอบ `db:false` และ route อื่นตอบ `503 backend_not_configured` (ไม่กระทบแอปที่ใช้อยู่)

### เปิดใช้งาน (ทำครั้งเดียว ผ่าน Cloudflare Dashboard)
1. Storage & Databases → D1 → **Create** ชื่อ `seascout-db` (เลือก location ใกล้ผู้ใช้หลัก เช่น APAC)
2. เปิดฐานข้อมูล → แท็บ **Console** → วางเนื้อหา `migrations/0001_membership.sql` ทั้งไฟล์ → Execute
3. คัดลอก **Database ID** (ไม่ใช่ความลับ) แล้วเพิ่มใน `wrangler.jsonc`:
   ```jsonc
   "d1_databases": [ { "binding": "DB", "database_name": "seascout-db", "database_id": "<ID>", "migrations_dir": "migrations" } ]
   ```
   (ต้องใส่ในไฟล์ เพราะ Workers Builds deploy จาก `wrangler.jsonc` — binding ที่ตั้งใน dashboard จะถูกเขียนทับ)
4. Commit + Push → Workers Builds deploy เอง → ตรวจ `https://seascout.apisit-chaikham.workers.dev/api/v1/health` ต้องได้ `"db":true`

## หลักความปลอดภัย
- รหัสผ่าน: PBKDF2-SHA256 100,000 รอบ + salt ต่อผู้ใช้ — ไม่เก็บรหัสผ่านจริง
- Token แบบสุ่ม (ไม่ใช่ JWT) เก็บเฉพาะ SHA-256 hash → เพิกถอนได้ทันที
  - access token อายุ 1 ชม., refresh token 60 วัน หมุนทุกครั้งที่ใช้
  - ใช้ refresh token เก่าซ้ำ = ถูกขโมย → เพิกถอนทั้งตระกูล session
- SQL แบบ parameter ทุกคำสั่ง, จำกัดขนาด body 16 KB, ตรวจรูปแบบข้อมูลทุกช่อง
- จำกัดการเดารหัส: 10 ครั้ง/อีเมล/15 นาที, 30 ครั้ง/IP/15 นาที, สมัคร 10 ครั้ง/IP/ชม.
- CORS เฉพาะ `https://localhost` (Android), `capacitor://localhost` (iOS), เว็บเดิม — ใช้ Bearer token (ไม่ใช้ cookie จึงไม่มี CSRF)
- Audit log: สมัคร, เข้าสู่ระบบ (สำเร็จ/ไม่สำเร็จ), เปลี่ยนรหัส, ลบอุปกรณ์, ลบบัญชี, ตรวจพบ token ซ้ำ — ไม่บันทึกรหัสผ่าน/token
- สิทธิ์ Premium/Pro มาจาก `subscriptions` + `plan_entitlements` บน server เท่านั้น

## Endpoints
ทุกคำขอ/คำตอบเป็น JSON (`Content-Type: application/json`). ผิดพลาด → `{ "error": "<code>", "message"? }`

| Method | Path | Auth | ใช้ทำ |
|---|---|---|---|
| GET | `/api/v1/health` | – | สถานะ `{ok, version, db}` |
| GET | `/api/v1/flags` | – | feature flags `{flags:{key:{enabled,rollout_pct}}}` |
| POST | `/api/v1/auth/register` | – | `{email, password(≥10), privacy_consent:true, privacy_version?, locale?, marketing_consent?, device?}` → 201 tokens + me |
| POST | `/api/v1/auth/login` | – | `{email, password, device?}` → tokens + me |
| POST | `/api/v1/auth/refresh` | – | `{refresh_token}` → tokens ใหม่ |
| POST | `/api/v1/auth/logout[?all=1]` | Bearer | ออกจากเครื่องนี้ / ทุกเครื่อง |
| GET | `/api/v1/me` | Bearer | user, profile, plan, subscription, entitlements |
| PATCH | `/api/v1/me/profile` | Bearer | `{display_name?, locale?, country?, units?, marketing_consent?}` |
| POST | `/api/v1/me/password` | Bearer | `{current_password, new_password}` (ออกจากเครื่องอื่นทั้งหมด) |
| GET | `/api/v1/me/entitlements` | Bearer | plan + entitlements |
| GET/POST | `/api/v1/me/devices` | Bearer | รายการอุปกรณ์ / ลงทะเบียน `{install_id, platform, model?, app_version?}` |
| DELETE | `/api/v1/me/devices/{id}` | Bearer | ลบอุปกรณ์ + ออกจากระบบเครื่องนั้น |
| DELETE | `/api/v1/me` | Bearer | ลบบัญชี `{password}` (หรือ `{confirm:"DELETE"}` สำหรับบัญชี Google/Apple) |
| POST | `/api/v1/auth/google`, `/auth/apple` | – | `{id_token, privacy_consent (ผู้ใช้ใหม่), device?}` → tokens + me (ตรวจกับ JWKS ของ Google/Apple) |
| POST | `/api/v1/auth/password/forgot` | – | `{email}` → 202 เสมอ, ส่งรหัส 8 ตัวทางอีเมล |
| POST | `/api/v1/auth/password/reset` | – | `{email, code, new_password}` (ออกจากทุกเครื่อง) |
| POST | `/api/v1/auth/email/verify/request`, `/auth/email/verify` | Bearer | ขอรหัส / `{code}` ยืนยันอีเมล |
| GET | `/api/v1/billing/account-tokens` | Bearer | ค่าที่แอปส่งให้ Store ตอนซื้อ + รายการสินค้า |
| POST | `/api/v1/billing/google/verify` | Bearer | `{purchase_token}` → ถาม Google Play → subscription |
| POST | `/api/v1/billing/google/notify` | OIDC (Pub/Sub) | RTDN |
| POST | `/api/v1/billing/apple/verify` | Bearer | `{original_transaction_id}` → ถาม App Store Server API |
| POST | `/api/v1/billing/apple/notify` | – | Server Notifications V2 (สถานะถามจาก Apple ใหม่ทุกครั้ง) |
| GET | `/api/v1/commerce/items?species=&gear=&cat=&group=&lang=&country=` | – | สินค้า + รูป + ข้อเสนอที่เหมาะกับประเทศ |
| GET | `/api/v1/go/{offer_id}` | – | 302 ไป URL ของข้อเสนอนั้น + นับคลิก |
| * | `/api/v1/admin/*` | Admin Bearer | ดู `worker/api/admin.js` / SeaScout_Admin.html |

ตั้งค่าบริการภายนอก: `docs/CONNECT_CHECKLIST_TH.md`

`device` = `{ install_id: "[A-Za-z0-9_-]{8,64}", platform: "android"|"ios"|"web", model?, app_version? }`
tokens = `{ session_id, access_token, access_expires_at, refresh_token, refresh_expires_at, token_type:"Bearer" }`

### Entitlements (ค่าเริ่มต้น — แก้ได้ในตาราง `plan_entitlements`)
| key | free | premium | pro |
|---|---|---|---|
| heatmap / heatmap_forecast / species_tackle / pattern_memory / advanced_forecast | false | true | true |
| offline_regions | 1 | 5 | 20 |
| ai_quota_daily | 0 | 20 | 200 |
| navigation / ocean_data | basic | full | full |
ราคาแพ็กเกจยังไม่กำหนด (ผูกกับสินค้าใน Store ผ่านตาราง `store_products`)

## ทดสอบ
`tests/integrations.test.mjs` + `tests/mock-stores.mjs` (Google/Apple/Resend จำลอง): 63/63 ผ่าน — Google/Apple sign-in (aud/iss/exp/ลายเซ็นปลอม), รหัสอีเมล, Google Play verify/ack/RTDN, App Store verify/notification, Admin (roles, grant/revoke, disable, flags, audit), Commerce (https เท่านั้น, ประเทศ, redirect เฉพาะ offer, นับคลิก), XSS ใน Admin

`tests/api.test.mjs` — รันกับ `wrangler dev` (D1 ในเครื่อง): ผล 61/61 ผ่าน ครอบคลุมของเดิมไม่เปลี่ยน, สมัคร/เข้าสู่ระบบ,
Android+iOS บัญชีเดียว, หมุน token/ตรวจ token ซ้ำ, SQL injection, body ผิดรูป/ใหญ่เกิน, เปลี่ยนรหัส, ลบอุปกรณ์, ออกจากระบบ, ลบบัญชี, จำกัดการเดารหัส

## Rollback
- ลบบรรทัด `if (url.pathname.startsWith('/api/v1/')) …` และ `import` ใน `worker/site.js` → Worker กลับเป็นแบบเดิม
- ถ้าผูก D1 แล้ว: เอา `d1_databases` ออกจาก `wrangler.jsonc` → API กลับเป็น 503 (ข้อมูลยังอยู่ใน D1; D1 มี Time Travel กู้คืนย้อนหลังได้)
