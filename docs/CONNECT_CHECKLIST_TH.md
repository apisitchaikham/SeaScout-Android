# Sea Scout — สมัครเสร็จแล้วเชื่อมทีเดียว (r14.15.61)

โค้ดฝั่ง server เขียนเสร็จและทดสอบกับระบบจำลองแล้ว (Google, Apple, Resend)
แต่ละส่วนเปิดเองเมื่อใส่ค่าครบ ถ้ายังไม่ใส่ endpoint จะตอบ `503 …_not_configured`
ดูสถานะได้ใน `SeaScout_Admin.html` → ภาพรวม → "สถานะระบบที่ต้องใช้บัญชีภายนอก"

## ใส่ค่าที่ไหน
Cloudflare Dashboard → Workers & Pages → **seascout** → Settings → **Variables and Secrets** → Add
- ใส่ทุกค่าเป็นชนิด **Secret** (เข้ารหัส และไม่หายเวลา deploy ใหม่)
- ห้ามใส่ค่าเหล่านี้ลงในไฟล์ใน repo
- ใส่แล้วกด Deploy ได้ทันที ไม่ต้องแก้โค้ด

---

## 1. อีเมล: ยืนยันอีเมล / ลืมรหัสผ่าน
| ต้องมี | ได้จาก |
|---|---|
| โดเมนสำหรับส่งอีเมล เช่น `seascout.app` | ซื้อโดเมน (Cloudflare Registrar ได้) |
| บัญชี Resend + ยืนยันโดเมน (DNS) | resend.com → Domains |

| Secret | ค่า |
|---|---|
| `RESEND_API_KEY` | `re_…` จาก Resend → API Keys |
| `EMAIL_FROM` | `Sea Scout <no-reply@โดเมนของคุณ>` |

## 2. เข้าสู่ระบบด้วย Google
Google Cloud Console → APIs & Services → Credentials → สร้าง OAuth client
- ชนิด **Android**: package `app.seascout.marine` + SHA-1 ของ keystore
- ชนิด **iOS**: bundle `app.seascout.marine`
- ชนิด **Web**: ใช้เป็น server client id

| Secret | ค่า |
|---|---|
| `GOOGLE_CLIENT_IDS` | client id ที่รับได้ทั้งหมด คั่นด้วย `,` |

## 3. Sign in with Apple
Apple Developer → Identifiers → App ID `app.seascout.marine` → เปิด Sign in with Apple

| Secret | ค่า |
|---|---|
| `APPLE_CLIENT_IDS` | `app.seascout.marine` (ถ้ามี Services ID เพิ่ม ให้คั่นด้วย `,`) |

## 3b. เข้าสู่ระบบด้วย Facebook
Meta for Developers → Create App (Consumer) → เพิ่ม Facebook Login
- Android: package `app.seascout.marine` + key hash
- iOS: bundle `app.seascout.marine`
- เปิด permission `email`
- เมื่อขายจริงต้องผ่าน App Review ของ Meta

| Secret | ค่า |
|---|---|
| `FACEBOOK_APP_ID` | App ID |
| `FACEBOOK_APP_SECRET` | App Secret (Settings → Basic) |
| `GOOGLE_WEB_CLIENT_ID` | (Google) Web client id ที่แอปใช้เริ่มปุ่ม Google |

หมายเหตุ: อีเมลจาก Facebook จะไม่ผูกกับบัญชีอีเมลเดิมให้อัตโนมัติ (กันการยึดบัญชี) ถ้าอีเมลนั้นมีบัญชีอยู่แล้ว ผู้ใช้ต้องเข้าสู่ระบบด้วยอีเมลก่อน

## 4. Google Play Billing
1. Play Console:
   - สร้างแอป `app.seascout.marine`
   - Monetize → Subscriptions → สร้างสินค้า เช่น `seascout_premium_monthly`, `seascout_pro_yearly`
2. Google Cloud: สร้าง Service Account → Keys → JSON
3. Play Console → Users and permissions → เชิญอีเมล service account ให้สิทธิ์ดูข้อมูลการเงินและจัดการคำสั่งซื้อ
4. (แนะนำ) Real-time developer notifications:
   - สร้าง Pub/Sub topic + push subscription ไปที่ `https://seascout.apisit-chaikham.workers.dev/api/v1/billing/google/notify`
   - เปิด Authentication: service account + audience

| Secret | ค่า |
|---|---|
| `GOOGLE_PLAY_PACKAGE` | `app.seascout.marine` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | เนื้อหาไฟล์ JSON ทั้งไฟล์ |
| `GOOGLE_RTDN_AUDIENCE` | audience ที่ตั้งใน push subscription |
| `GOOGLE_RTDN_SA_EMAIL` | อีเมล service account ของ push subscription |

จากนั้นใน Admin → แพ็กเกจ & Store ให้ผูก product id กับแพ็กเกจ (premium / pro)

## 5. App Store (StoreKit)
1. App Store Connect:
   - สร้างแอป → Subscriptions → สร้างสินค้า
   - Users and Access → Integrations → In-App Purchase key (.p8)
2. App Store Server Notifications V2: ตั้ง URL `https://seascout.apisit-chaikham.workers.dev/api/v1/billing/apple/notify`

| Secret | ค่า |
|---|---|
| `APPLE_BUNDLE_ID` | `app.seascout.marine` |
| `APPLE_ISSUER_ID` | Issuer ID |
| `APPLE_KEY_ID` | Key ID ของ .p8 |
| `APPLE_PRIVATE_KEY` | เนื้อหาไฟล์ .p8 ทั้งไฟล์ |
| `APPLE_ENV` | `Sandbox` ระหว่างทดสอบ (ลบออกเมื่อขายจริง) |

จากนั้นใน Admin → แพ็กเกจ & Store ให้ผูก product id

## 6. เปิดใช้สิทธิ์จาก server
เมื่อทดสอบซื้อจริงผ่าน (sandbox) แล้ว ไปที่ Admin → เปิด/ปิดฟังก์ชัน → `server_premium` = เปิด
แอปจะใช้สิทธิ์จากบัญชีแทนการปลดล็อกในเครื่อง ส่วน `tester_unlock` จะเก็บไว้หรือปิดก็ได้

---

## หน้าเข้าสู่ระบบหลังเปิดแอป (r14.15.61)
- แสดงหลังหน้าโหลด: Google, Facebook, Apple (เฉพาะ iPhone/iPad), ใช้อีเมล, ข้ามไปก่อน
- ไม่ขึ้นเมื่อไม่มีอินเทอร์เน็ต (ระบบนำทางต้องใช้ได้เสมอ)
- กด "ข้ามไปก่อน" แล้วจะไม่ถามซ้ำ 3 วัน
- เปิดหน้านี้เองได้จากปุ่ม 🔐 ในแผงบัญชี
- Admin → เปิด/ปิดฟังก์ชัน:
  - `login_screen` = แสดงหน้านี้ / ไม่แสดง
  - `login_required` = ซ่อนปุ่มข้าม
- กฎที่ต้องรู้:
  - App Store 4.8: มี Google/Facebook ต้องมี Apple ด้วย (ทำไว้แล้ว)
  - App Store 5.1.1: ไม่ควรบังคับสมัครถ้าฟีเจอร์หลักไม่ต้องใช้บัญชี → แนะนำให้ `login_required` ปิดไว้ตอนส่งรีวิว
- ปุ่ม Google/Facebook บนเว็บใช้ SDK ของผู้ให้บริการ (โหลดเมื่อกด)
- ในแอปมือถือใช้ plugin `@capgo/capacitor-social-login` (Google + Facebook + Apple ใน plugin เดียว)
  - ติดตั้งหลังได้ App ID: `npm i @capgo/capacitor-social-login` → `npx cap sync` → ใส่ App ID ใน `strings.xml` / `Info.plist` ตามคู่มือ plugin
  - โค้ดในแอปเรียก plugin นี้ไว้แล้ว ถ้ายังไม่ได้ติดตั้ง ปุ่มจะแจ้งให้ใช้อีเมลไปก่อน

## ฝั่งแอปที่ยังต้องเพิ่มหลังได้ค่าข้างบน
ต้องมีไฟล์ตั้งค่าจริงก่อนถึงจะติดตั้งและทดสอบได้
- **ปุ่ม Google / Apple ในหน้าบัญชี:** native plugin ส่ง `id_token` ไป `/auth/google` หรือ `/auth/apple`
- **ปุ่มซื้อ Premium/Pro:** plugin Billing / StoreKit ส่ง `purchase_token` หรือ `original_transaction_id` ไป `/billing/*/verify`
  - ส่ง `google_obfuscated_account_id` / `apple_app_account_token` จาก `/billing/account-tokens` ไปกับคำสั่งซื้อทุกครั้ง
- **หน้าลืมรหัสผ่าน / ยืนยันอีเมล:** หน้าจอกรอกรหัส 8 ตัวในแอป (API พร้อมแล้ว)
- **นโยบายความเป็นส่วนตัว:** ลิงก์ในช่องยินยอมตอนสมัคร (ต้องมีก่อนส่ง Store)

## ผู้ดูแลระบบ (SeaScout_Admin.html)
1. สมัครบัญชี Sea Scout ด้วยอีเมลเจ้าของในแอป
2. แถว `admin_users` ของอีเมลนั้นใส่ไว้แล้วเป็น owner
3. เปิดไฟล์ `admin/SeaScout_Admin.html` ในเบราว์เซอร์บนคอม → ใส่อีเมล + รหัสผ่าน
- ไฟล์นี้ไม่มีความลับใดๆ token อยู่ในแท็บนั้นเท่านั้นและหมดอายุใน 2 ชม.
- เพิ่มผู้ช่วยได้ในแท็บ "ผู้ดูแล": viewer / support / admin / owner
