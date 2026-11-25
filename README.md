# Job Search Tracker

Dashboard proses lamaran kerja: di mana saja melamar, sumbernya (LinkedIn, referral, website), posisi, dan statusnya sampai mana. Arsitekturnya sama dengan `riyan-workout-dash`.

## Arsitektur

```
              CLAUDE
       Development / Coding
                 │
                 ▼
              GITHUB
        Source Code / Logic
                 │
                 ▼
           GITHUB PAGES
       Job Search Dashboard         index.html · app.js · styles.css
                 │
                 ▼
            DATA STORE
           Google Sheets
   store.js ⇄ apps-script/Code.gs
```

| File | Peran |
|---|---|
| `index.html`, `styles.css`, `app.js` | Tampilan dashboard (tab Ringkasan dan Lamaran, form tambah/edit) |
| `store.js` | Klien data: baca/tulis ke Google Sheets, cache lokal, antrean offline |
| `apps-script/Code.gs` | API di Google Sheets (Apps Script Web App). Tab `Lamaran` berisi satu baris per lamaran dan bisa diedit langsung |

Data lamaran **tidak** disimpan di repo ini. URL Apps Script dan kunci API hanya disimpan di browser masing-masing perangkat.

## Setup

### 1. Google Sheets + Apps Script
1. Login ke Google dengan akun **pribadi**, lalu buat Google Sheet baru, misalnya **Job Search Data**.
2. **Extensions → Apps Script**, hapus isi `Code.gs`, tempel isi `apps-script/Code.gs` dari repo ini, lalu simpan.
3. Pilih fungsi `setup` → **Run** → izinkan akses. Buka **Execution log** dan salin **API key**.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Salin URL yang berakhiran `/exec`.

> Setiap kali `Code.gs` diubah: **Deploy → Manage deployments → Edit → Version: New version**. URL tetap sama.

### 2. GitHub Pages
Buat repo baru (boleh private kalau akun GitHub mendukung Pages untuk repo private), push isi folder ini, lalu
**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
Dashboard tersedia di `https://<username>.github.io/riyan-job-tracker/`.

### 3. Sambungkan di setiap perangkat
Buka dashboard → **Sambungan** → tempel URL `/exec` dan API key → **Simpan & tes**.

### 4. Pindahkan data lama (sekali saja)
Klik **Impor JSON** dan pilih `private/lamaran.export.json` (atau file hasil **Backup JSON** dari tracker lama). Lamaran yang sama tidak akan dobel karena id-nya dipakai ulang.

## Keamanan
- Siapa pun yang tahu URL **dan** kunci API bisa membaca/menulis data. Jangan bagikan keduanya.
- Kalau kunci bocor: jalankan `rotateKey()` di Apps Script, lalu sambungkan ulang perangkat Anda.
- Halaman dashboard sendiri tidak berisi data, jadi aman walaupun repo-nya publik.
