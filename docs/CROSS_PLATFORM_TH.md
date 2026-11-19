# Sea Scout — แก้ครั้งเดียว ได้ทั้ง Android และ iPhone/iPad

## หลักการ
```
build.py (โค้ดแอปทั้งหมด)  →  www/index.html  (+ www/lib, www/media, www/awois)
                                     │
                         push ขึ้น GitHub ครั้งเดียว
                    ┌────────────────┴────────────────┐
           Build Android (android.yml)        Build iOS (ios.yml)
           npx cap sync android               npx cap sync ios
           → APK / AAB                        → Simulator build / .ipa / TestFlight
```
- หน้าจอ ฟังก์ชัน แผนที่ ข้อมูลทะเล วิเคราะห์ ภาษา ทั้งหมดอยู่ใน `www/` ชุดเดียว — **ห้ามแก้โค้ดแอปใน `android/` หรือ `ios/`**
- ความต่างของระบบอยู่ในชั้นเดียว: `SeaPlatform` (GPS, แจ้งเตือน, จอไม่ดับ, แชร์/ไฟล์) + `native.js`
  - ใช้ `window.SEA_PLATFORM` (`'android'` / `'ios'`) และคลาส `sea-android` / `sea-ios` บน `<html>` เมื่อจำเป็นจริงๆ
  - เฉพาะ Android: notification channel, ปุ่มย้อนกลับ, ไอคอนแจ้งเตือนเล็ก
  - เฉพาะ iOS: แอปเปิดจาก `capacitor://localhost` (Android คือ `https://localhost`) — โค้ดเช็กทั้งสองแบบแล้ว
- ตั้งค่าร่วม: `capacitor.config.json` (appId `app.seascout.marine` เหมือนกันทั้งสองระบบ)

## ขั้นตอนปกติ
1. แก้ใน build.py / ไฟล์โมดูล → สร้าง `www/index.html`
2. Commit + Push ใน GitHub Desktop
3. GitHub Actions สร้างทั้งสองแอปพร้อมกัน
   - Android: APK ใน Releases (`seascout-build-N`)
   - iOS: artifact `SeaScout-ios-simulator` เสมอ, `.ipa` + TestFlight เมื่อใส่ secrets แล้ว

## เพิ่ม plugin ใหม่
`npm install <plugin>` แล้ว `npx cap sync` (ไม่ระบุระบบ = ทั้งสองระบบ) แล้ว commit `package.json`, `package-lock.json`,
`android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle`, `ios/App/CapApp-SPM/Package.swift`
ใช้ได้เฉพาะ plugin ที่รองรับทั้ง Android และ iOS

## iOS: สิ่งที่เจ้าของต้องทำเอง (ต้องใช้บัญชี Apple)
1. สมัคร Apple Developer Program
2. สร้าง App ID `app.seascout.marine`, Distribution certificate (.p12), App Store provisioning profile
3. ใส่ GitHub Secrets: `IOS_P12_BASE64`, `IOS_P12_PASSWORD`, `IOS_PROFILE_BASE64`, `APPLE_TEAM_ID`
4. (ส่ง TestFlight อัตโนมัติ) `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_BASE64` (App Store Connect API key)
ไม่ต้องมี Mac — สร้างบน GitHub macOS runner

## ข้อจำกัดที่รู้แล้ว
- iOS: Service Worker ใช้ไม่ได้บน `capacitor://` → แคชแผนที่ออฟไลน์แบบ SW ไม่ทำงานบน iPhone (ข้อมูลอื่นที่เก็บใน IndexedDB/localStorage ใช้ได้)
- ไอคอน iOS ขยายจากไอคอน Android 432 px — ก่อนส่ง App Store ควรมีไฟล์ต้นฉบับ 1024×1024
- GitHub Actions: นาทีของ macOS runner คิดแพงกว่า Linux (repo ส่วนตัว)

## Rollback
- ทั้งชุดนี้เป็นการเพิ่ม (additive): ลบโฟลเดอร์ `ios/` + `.github/workflows/ios.yml` และคืน `package.json`/`package-lock.json`/`capacitor.config.json`
  จาก commit ก่อนหน้า → Android กลับเป็นเหมือนเดิมทุกอย่าง
- ใน GitHub Desktop: History → คลิกขวา commit → Revert changes in commit
