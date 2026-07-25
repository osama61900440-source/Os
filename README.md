# Gurage POS App — GitHub Pages ላይ ማስቀመጫ መመሪያ

## ​ችግሩ ምን ነበር?
1. **ፋይሉ `index.html` ተብሎ አልነበረም።** GitHub Pages በራስ-ሰር የሚከፍተው `index.html` የሚባለውን ፋይል ብቻ ነው። ስሙ የተለየ ከሆነ (ለምሳሌ `gurage-pos-app.html`) የፕሮጀክቱ ዋና ሊንክ ላይ ስትገቡ 404 ያሳያል።
2. **`window.storage` የተባለው API** የሚሰራው በClaude Artifact ውስጥ ብቻ ነው፤ በGitHub Pages ላይ ስለሌለ መተግበሪያው ላይ ስህተት ፈጥሮ ነበር (ዕቃ መጨመር፣ ሽያጭ ማጠናቀቅ ወዘተ የማይሰሩበት ምክንያት ይሄ ነው)። አሁን ወደ `localStorage` በራስ-ሰር እንዲቀየር (fallback) ተደርጓል።

## ​ፎልደሩ ውስጥ ያለው
```
index.html          ← ዋናው መተግበሪያ (ይሄ መሆን ያለበት ስም)
manifest.json        ← መተግበሪያውን "Install" ማድረግ የሚያስችል PWA ፋይል
sw.js                 ← ኦፍላይን እንዲሰራ የሚያግዝ Service Worker
icons/                ← የመተግበሪያ አዶዎች (192px, 512px, apple touch)
README.md             ← ይሄ መመሪያ
```

## ​በGitHub Pages ላይ እንዴት ማስቀመጥ ይቻላል?

1. በGitHub ላይ አዲስ ወይም ነባር repository ይክፈቱ።
2. ​በዚህ ፎልደር ውስጥ ያሉትን ፋይሎች በሙሉ (index.html, manifest.json, sw.js, icons/ አቃፊውን ጨምሮ) **ወደ repository ዋናው ሥር (root)** ይስቀሉ — ንዑስ ፎልደር ውስጥ አያድርጓቸው።
3. ​ወደ repository **Settings → Pages** ይሂዱ።
4. ​ከ "Build and deployment" ስር:
   - Source: **Deploy from a branch**
   - Branch: **main** (ወይም የሚጠቀሙት ብራንች) እና ​ **/ (root)** የሚለውን ይምረጡ
   - **Save** ይጫኑ።
5. ​ከ1-3 ደቂቃ በኋላ ሊንኩ ይታያል፦ `https://<የተጠቃሚ-ስም>.github.io/<repository-ስም>/`
6. ​ያንን ሊንክ በስልክዎ ወይም ኮምፒውተር ላይ ይክፈቱት።

## ​እንደ እውነተኛ የሞባይል አፕ ለመጫን (Install)
- **Android/Chrome**: ሊንኩን ይክፈቱ → ⋮ ምናሌ → **"Add to Home screen"** / **"Install app"**።
- **iPhone/Safari**: ሊንኩን ይክፈቱ → የማጋሪያ (Share) አዝራር → **"Add to Home Screen"**።
- ​ከተጫነ በኋላ እንደ መደበኛ አፕ በራሱ አዶ ከHome Screen ይከፈታል፣ የብራውዘር አድራሻ መስመር (address bar) ​ አይታይም።

## ​ማስተካከያ የተደረገባቸው ነጥቦች (ይህ ዙር)
- ✅ ፋይሉ ወደ `index.html` ተቀይሯል (GitHub Pages በትክክል እንዲከፍተው)
- ✅ `window.storage` ጥገኝነት ተስተካክሎ ወደ `localStorage` fallback ገብቷል (በGitHub Pages ላይ ስራ ላይ ይውላል)
- ✅ PWA `manifest.json` + `sw.js` + አዶዎች ተጨምረዋል → መተግበሪያውን ወደ Home Screen መጫን ይቻላል
- ✅ Splash screen (የመክፈቻ ገጽ)፣ safe-area padding (ለNotch ስልኮች)፣ smoother animations ተጨምረዋል
- ✅ `prefers-reduced-motion` እና keyboard focus outlines ለተደራሽነት (accessibility) ተካትተዋል
- ✅ የገጽታ ቅንብሮች (Dark mode, ቀለም, የፅሁፍ መጠን) አሁን ይቀመጣሉ እና ዳግም ሲከፈት ይታወሳሉ

## ​ማስታወሻ
ይህ still frontend-only ናሙና ነው (real backend/database/OTP/Chapa-Telebirr ግንኙነት የለውም)። መረጃው የሚቀመጠው በእያንዳንዱ ተጠቃሚ ስልክ/ብራውዘር ላይ ብቻ ነው (localStorage)፤ በተለያዩ መሳሪያዎች መካከል አይመሳሰልም። እውነተኛ ባለብዙ-ተጠቃሚ ስሪት ለመስራት የጀርባ (backend) አገልግሎት (database + auth + real-time sync) ያስፈልጋል።
