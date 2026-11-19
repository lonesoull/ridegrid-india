import type { VoiceLang } from './dailyNav';

/**
 * Daily-mode voice prompts in Indian languages (OsmAnd voice packs). The navigator speaks English
 * sentences; this turns the known ones into the chosen language. Unknown sentences stay English.
 * The phone's own text-to-speech voice for that language is used (Android: Settings → Text-to-speech).
 */
type Tbl = {
  inM: (n: string) => string; inKm: (n: string) => string; onto: (r: string, rest: string) => string;
  left: string; right: string; bearL: string; bearR: string; sharpL: string; sharpR: string; uturn: string; keepL: string; keepR: string;
  merge: string; ramp: string; exit: string; cont: string; round: (n: string) => string;
  phrases: Record<string, string>;
};
const ALERTS = ['Speed camera ahead', 'Speed breaker ahead', 'Railway crossing ahead', 'Toll plaza ahead', 'Traffic signal ahead', 'Pedestrian crossing ahead', 'Stop sign ahead', 'Hazard ahead', 'Slow down', 'Route complete', 'Back on route', 'Route updated', 'Taking the faster route'];
const P = (vals: string[]) => Object.fromEntries(ALERTS.map((k, i) => [k, vals[i]]));

const T: Partial<Record<VoiceLang, Tbl>> = {
  'hi-IN': { inM: (n) => `${n} मीटर बाद`, inKm: (n) => `${n} किलोमीटर बाद`, onto: (r, x) => `${r} पर ${x}`,
    left: 'बाएँ मुड़ें', right: 'दाएँ मुड़ें', bearL: 'हल्का बाएँ चलें', bearR: 'हल्का दाएँ चलें', sharpL: 'तेज़ बाएँ मुड़ें', sharpR: 'तेज़ दाएँ मुड़ें', uturn: 'यू-टर्न लें',
    keepL: 'बाएँ रहें', keepR: 'दाएँ रहें', merge: 'सड़क में मिलें', ramp: 'रैम्प लें', exit: 'निकास लें', cont: 'सीधे चलें', round: (n) => `गोल चक्कर पर ${n} निकास लें`,
    phrases: P(['आगे स्पीड कैमरा है', 'आगे स्पीड ब्रेकर है', 'आगे रेलवे फाटक है', 'आगे टोल प्लाज़ा है', 'आगे ट्रैफिक सिग्नल है', 'आगे पैदल क्रॉसिंग है', 'आगे स्टॉप साइन है', 'आगे खतरा है', 'गति कम करें', 'रास्ता पूरा हुआ', 'रास्ते पर वापस', 'रास्ता बदला गया', 'तेज़ रास्ता ले रहे हैं']) },
  'ta-IN': { inM: (n) => `${n} மீட்டரில்`, inKm: (n) => `${n} கிலோமீட்டரில்`, onto: (r, x) => `${x}, ${r}`,
    left: 'இடது பக்கம் திரும்பவும்', right: 'வலது பக்கம் திரும்பவும்', bearL: 'சற்று இடது பக்கம் செல்லவும்', bearR: 'சற்று வலது பக்கம் செல்லவும்', sharpL: 'கூர்மையாக இடது பக்கம் திரும்பவும்', sharpR: 'கூர்மையாக வலது பக்கம் திரும்பவும்', uturn: 'யூ-டர்ன் எடுக்கவும்',
    keepL: 'இடது பக்கம் செல்லவும்', keepR: 'வலது பக்கம் செல்லவும்', merge: 'சாலையில் இணையவும்', ramp: 'சரிவுப் பாதையை எடுக்கவும்', exit: 'வெளியேறவும்', cont: 'நேராகச் செல்லவும்', round: (n) => `ரவுண்டானாவில் ${n} வெளியேறலை எடுக்கவும்`,
    phrases: P(['முன்னால் வேக கேமரா உள்ளது', 'முன்னால் வேகத்தடை உள்ளது', 'முன்னால் ரயில்வே கிராசிங் உள்ளது', 'முன்னால் சுங்கச்சாவடி உள்ளது', 'முன்னால் போக்குவரத்து சிக்னல் உள்ளது', 'முன்னால் பாதசாரி கடக்கும் இடம் உள்ளது', 'முன்னால் நிறுத்தக் குறி உள்ளது', 'முன்னால் ஆபத்து', 'வேகத்தைக் குறைக்கவும்', 'பயணம் முடிந்தது', 'மீண்டும் பாதையில்', 'பாதை புதுப்பிக்கப்பட்டது', 'வேகமான பாதையை எடுக்கிறோம்']) },
  'te-IN': { inM: (n) => `${n} మీటర్లలో`, inKm: (n) => `${n} కిలోమీటర్లలో`, onto: (r, x) => `${x}, ${r}`,
    left: 'ఎడమవైపు తిరగండి', right: 'కుడివైపు తిరగండి', bearL: 'కొంచెం ఎడమవైపు వెళ్ళండి', bearR: 'కొంచెం కుడివైపు వెళ్ళండి', sharpL: 'పూర్తిగా ఎడమవైపు తిరగండి', sharpR: 'పూర్తిగా కుడివైపు తిరగండి', uturn: 'యూ-టర్న్ తీసుకోండి',
    keepL: 'ఎడమవైపు ఉండండి', keepR: 'కుడివైపు ఉండండి', merge: 'రోడ్డులో కలవండి', ramp: 'ర్యాంప్ తీసుకోండి', exit: 'నిష్క్రమణ తీసుకోండి', cont: 'నేరుగా వెళ్ళండి', round: (n) => `రౌండ్‌అబౌట్ వద్ద ${n} నిష్క్రమణ తీసుకోండి`,
    phrases: P(['ముందు స్పీడ్ కెమెరా ఉంది', 'ముందు స్పీడ్ బ్రేకర్ ఉంది', 'ముందు రైల్వే క్రాసింగ్ ఉంది', 'ముందు టోల్ ప్లాజా ఉంది', 'ముందు ట్రాఫిక్ సిగ్నల్ ఉంది', 'ముందు పాదచారుల క్రాసింగ్ ఉంది', 'ముందు స్టాప్ గుర్తు ఉంది', 'ముందు ప్రమాదం', 'వేగం తగ్గించండి', 'ప్రయాణం పూర్తయింది', 'మళ్ళీ మార్గంలో', 'మార్గం నవీకరించబడింది', 'వేగవంతమైన మార్గం తీసుకుంటున్నాం']) },
  'kn-IN': { inM: (n) => `${n} ಮೀಟರ್ ನಂತರ`, inKm: (n) => `${n} ಕಿಲೋಮೀಟರ್ ನಂತರ`, onto: (r, x) => `${x}, ${r}`,
    left: 'ಎಡಕ್ಕೆ ತಿರುಗಿ', right: 'ಬಲಕ್ಕೆ ತಿರುಗಿ', bearL: 'ಸ್ವಲ್ಪ ಎಡಕ್ಕೆ ಹೋಗಿ', bearR: 'ಸ್ವಲ್ಪ ಬಲಕ್ಕೆ ಹೋಗಿ', sharpL: 'ತೀಕ್ಷ್ಣವಾಗಿ ಎಡಕ್ಕೆ ತಿರುಗಿ', sharpR: 'ತೀಕ್ಷ್ಣವಾಗಿ ಬಲಕ್ಕೆ ತಿರುಗಿ', uturn: 'ಯು-ಟರ್ನ್ ತೆಗೆದುಕೊಳ್ಳಿ',
    keepL: 'ಎಡಭಾಗದಲ್ಲಿ ಇರಿ', keepR: 'ಬಲಭಾಗದಲ್ಲಿ ಇರಿ', merge: 'ರಸ್ತೆಗೆ ಸೇರಿ', ramp: 'ರ್ಯಾಂಪ್ ತೆಗೆದುಕೊಳ್ಳಿ', exit: 'ನಿರ್ಗಮನ ತೆಗೆದುಕೊಳ್ಳಿ', cont: 'ನೇರವಾಗಿ ಮುಂದುವರಿಯಿರಿ', round: (n) => `ವೃತ್ತದಲ್ಲಿ ${n} ನಿರ್ಗಮನ ತೆಗೆದುಕೊಳ್ಳಿ`,
    phrases: P(['ಮುಂದೆ ವೇಗ ಕ್ಯಾಮೆರಾ ಇದೆ', 'ಮುಂದೆ ಸ್ಪೀಡ್ ಬ್ರೇಕರ್ ಇದೆ', 'ಮುಂದೆ ರೈಲ್ವೆ ಕ್ರಾಸಿಂಗ್ ಇದೆ', 'ಮುಂದೆ ಟೋಲ್ ಪ್ಲಾಜಾ ಇದೆ', 'ಮುಂದೆ ಟ್ರಾಫಿಕ್ ಸಿಗ್ನಲ್ ಇದೆ', 'ಮುಂದೆ ಪಾದಚಾರಿ ದಾಟುವ ಸ್ಥಳ ಇದೆ', 'ಮುಂದೆ ನಿಲುಗಡೆ ಫಲಕ ಇದೆ', 'ಮುಂದೆ ಅಪಾಯ', 'ವೇಗ ಕಡಿಮೆ ಮಾಡಿ', 'ಪ್ರಯಾಣ ಮುಗಿದಿದೆ', 'ಮತ್ತೆ ಮಾರ್ಗದಲ್ಲಿ', 'ಮಾರ್ಗ ನವೀಕರಿಸಲಾಗಿದೆ', 'ವೇಗದ ಮಾರ್ಗ ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದೇವೆ']) },
  'ml-IN': { inM: (n) => `${n} മീറ്റർ കഴിഞ്ഞ്`, inKm: (n) => `${n} കിലോമീറ്റർ കഴിഞ്ഞ്`, onto: (r, x) => `${x}, ${r}`,
    left: 'ഇടത്തോട്ട് തിരിയുക', right: 'വലത്തോട്ട് തിരിയുക', bearL: 'ചെറുതായി ഇടത്തോട്ട് പോകുക', bearR: 'ചെറുതായി വലത്തോട്ട് പോകുക', sharpL: 'കുത്തനെ ഇടത്തോട്ട് തിരിയുക', sharpR: 'കുത്തനെ വലത്തോട്ട് തിരിയുക', uturn: 'യു-ടേൺ എടുക്കുക',
    keepL: 'ഇടതുവശം ചേർന്ന് പോകുക', keepR: 'വലതുവശം ചേർന്ന് പോകുക', merge: 'റോഡിൽ ചേരുക', ramp: 'റാമ്പ് എടുക്കുക', exit: 'എക്സിറ്റ് എടുക്കുക', cont: 'നേരെ പോകുക', round: (n) => `റൗണ്ട് എബൗട്ടിൽ ${n} എക്സിറ്റ് എടുക്കുക`,
    phrases: P(['മുന്നിൽ സ്പീഡ് ക്യാമറ ഉണ്ട്', 'മുന്നിൽ സ്പീഡ് ബ്രേക്കർ ഉണ്ട്', 'മുന്നിൽ റെയിൽവേ ക്രോസിംഗ് ഉണ്ട്', 'മുന്നിൽ ടോൾ പ്ലാസ ഉണ്ട്', 'മുന്നിൽ ട്രാഫിക് സിഗ്നൽ ഉണ്ട്', 'മുന്നിൽ കാൽനട ക്രോസിംഗ് ഉണ്ട്', 'മുന്നിൽ സ്റ്റോപ്പ് അടയാളം ഉണ്ട്', 'മുന്നിൽ അപകടം', 'വേഗം കുറയ്ക്കുക', 'യാത്ര പൂർത്തിയായി', 'വീണ്ടും വഴിയിൽ', 'വഴി പുതുക്കി', 'വേഗമേറിയ വഴി എടുക്കുന്നു']) },
  'mr-IN': { inM: (n) => `${n} मीटर नंतर`, inKm: (n) => `${n} किलोमीटर नंतर`, onto: (r, x) => `${x}, ${r}`,
    left: 'डावीकडे वळा', right: 'उजवीकडे वळा', bearL: 'थोडे डावीकडे जा', bearR: 'थोडे उजवीकडे जा', sharpL: 'तीव्र डावीकडे वळा', sharpR: 'तीव्र उजवीकडे वळा', uturn: 'यू-टर्न घ्या',
    keepL: 'डावीकडे राहा', keepR: 'उजवीकडे राहा', merge: 'रस्त्यात सामील व्हा', ramp: 'रॅम्प घ्या', exit: 'बाहेर पडा', cont: 'सरळ चला', round: (n) => `गोलाकारावर ${n} बाहेर पडण्याचा मार्ग घ्या`,
    phrases: P(['पुढे स्पीड कॅमेरा आहे', 'पुढे स्पीड ब्रेकर आहे', 'पुढे रेल्वे फाटक आहे', 'पुढे टोल नाका आहे', 'पुढे ट्रॅफिक सिग्नल आहे', 'पुढे पादचारी क्रॉसिंग आहे', 'पुढे थांबा चिन्ह आहे', 'पुढे धोका आहे', 'वेग कमी करा', 'प्रवास पूर्ण झाला', 'पुन्हा मार्गावर', 'मार्ग बदलला', 'जलद मार्ग घेत आहोत']) },
  'bn-IN': { inM: (n) => `${n} মিটার পরে`, inKm: (n) => `${n} কিলোমিটার পরে`, onto: (r, x) => `${x}, ${r}`,
    left: 'বাঁদিকে ঘুরুন', right: 'ডানদিকে ঘুরুন', bearL: 'একটু বাঁদিকে যান', bearR: 'একটু ডানদিকে যান', sharpL: 'তীক্ষ্ণভাবে বাঁদিকে ঘুরুন', sharpR: 'তীক্ষ্ণভাবে ডানদিকে ঘুরুন', uturn: 'ইউ-টার্ন নিন',
    keepL: 'বাঁদিকে থাকুন', keepR: 'ডানদিকে থাকুন', merge: 'রাস্তায় মিশে যান', ramp: 'র‍্যাম্প নিন', exit: 'বের হওয়ার পথ নিন', cont: 'সোজা চলুন', round: (n) => `গোলচত্বরে ${n} বের হওয়ার পথ নিন`,
    phrases: P(['সামনে স্পিড ক্যামেরা আছে', 'সামনে স্পিড ব্রেকার আছে', 'সামনে রেলগেট আছে', 'সামনে টোল প্লাজা আছে', 'সামনে ট্রাফিক সিগন্যাল আছে', 'সামনে পথচারী পারাপার আছে', 'সামনে থামার চিহ্ন আছে', 'সামনে বিপদ', 'গতি কমান', 'যাত্রা শেষ', 'আবার পথে', 'পথ হালনাগাদ হয়েছে', 'দ্রুততর পথ নেওয়া হচ্ছে']) },
};

export function translate(text: string, lang: VoiceLang): string {
  const t = T[lang];
  if (!t) return text;
  if (t.phrases[text.replace(/\.$/, '')]) return t.phrases[text.replace(/\.$/, '')];
  let pre = '', rest = text;
  const m = /^In ([\d.]+) (metres|kilometres), (.*)$/i.exec(text);
  if (m) { pre = (m[2].startsWith('k') ? t.inKm(m[1]) : t.inM(m[1])) + ', '; rest = m[3]; }
  const on = / onto (.+)$/i.exec(rest);
  const road = on?.[1];
  const core = (on ? rest.slice(0, on.index) : rest).trim().toLowerCase();
  const rx = /^at the roundabout, take the (\d+)\w* exit$/.exec(core);
  const map: Record<string, string> = { 'turn left': t.left, 'turn right': t.right, 'bear left': t.bearL, 'bear right': t.bearR, 'sharp left': t.sharpL, 'sharp right': t.sharpR,
    'make a u-turn': t.uturn, 'keep left': t.keepL, 'keep right': t.keepR, merge: t.merge, 'take the ramp': t.ramp, 'take the exit': t.exit, continue: t.cont, 'at the roundabout, take the exit': t.round('') };
  const said = rx ? t.round(rx[1]) : map[core];
  if (!said) return text;
  return pre + (road ? t.onto(road, said) : said);
}

export const VOICE_LABEL: Record<VoiceLang, string> = { 'en-IN': 'English (India)', 'hi-IN': 'हिन्दी Hindi', 'ta-IN': 'தமிழ் Tamil', 'te-IN': 'తెలుగు Telugu', 'kn-IN': 'ಕನ್ನಡ Kannada', 'ml-IN': 'മലയാളം Malayalam', 'mr-IN': 'मराठी Marathi', 'bn-IN': 'বাংলা Bengali' };
