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

## Get found on Google
1. Go to https://search.google.com/search-console and add a **URL prefix** property: https://p2-pdf.vercel.app/
2. Verify with the **HTML tag** method: copy the `<meta name="google-site-verification" ...>` line it shows into the `<head>` of `index.html`, push, then click Verify.
3. Open **Sitemaps** and submit `sitemap.xml`.
4. Open **URL inspection**, paste the site address, and click **Request indexing**.
`robots.txt`, `sitemap.xml`, the page title/description, social preview image and structured data are already included. If you move to another domain, search and replace `p2-pdf.vercel.app` in `index.html`, `robots.txt` and `sitemap.xml`.

## Notes
- Camera: uses the phone's full-resolution photo mode and autofocus where the browser supports it. Tap the preview to refocus. A Light button appears when the phone has a torch.
- Pages can be rotated, and one filter can be applied to every page.
- Auto-detect is strict on purpose: it shows nothing unless it finds a real sheet, and it refines the corners against the actual edges.
- The camera only works on https or localhost.
- OpenCV.js is bundled in public/opencv.js (about 10 MB) so detection works offline.
- Laptop and front cameras show a mirrored preview (toggle "Mirror" in the camera). Saved photos are never mirrored.
- Limit: 10 pages per PDF, shared between camera and uploads.
