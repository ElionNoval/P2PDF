# P2PDF

Photo-to-PDF converter and installable PWA. React + Vite, OpenCV.js, Canvas, jsPDF. Everything runs on the device.

## Run
    npm install
    npm run dev        # http://localhost:5173
    npm run build      # production build in dist/

## Host on GitHub Pages
1. Create an empty repo on github.com (for example `p2pdf`).
2. In this folder:
       git init
       git add .
       git commit -m "P2PDF"
       git branch -M main
       git remote add origin https://github.com/YOUR-USERNAME/p2pdf.git
       git push -u origin main
3. Repo Settings > Pages > Source: **GitHub Actions**. After the workflow finishes, open
   https://YOUR-USERNAME.github.io/p2pdf/

## Install as an app (PWA)
- Android Chrome: tap "Install app" on the home screen, or menu > Install app.
- iPhone Safari: Share > Add to Home Screen.
After the first visit it opens and scans offline. To force everyone onto fresh files, bump `CACHE` in `public/sw.js`.

## Notes
- The camera only works on https or localhost.
- OpenCV.js is bundled in public/opencv.js (about 10 MB) so detection works offline.
- Laptop and front cameras show a mirrored preview (toggle "Mirror" in the camera). Saved photos are never mirrored.
- Limit: 10 pages per PDF, shared between camera and uploads.
