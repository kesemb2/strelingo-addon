// Languages offered on the configure page (OpenSubtitles 3-letter codes).
export const languageMap: Record<string, string> = {
    'abk': 'Abkhazian', 'afr': 'Afrikaans', 'alb': 'Albanian', 'amh': 'Amharic', 'ara': 'Arabic',
    'arg': 'Aragonese', 'arm': 'Armenian', 'asm': 'Assamese', 'ast': 'Asturian', 'azb': 'South Azerbaijani',
    'aze': 'Azerbaijani', 'baq': 'Basque', 'bel': 'Belarusian', 'ben': 'Bengali', 'bos': 'Bosnian',
    'bre': 'Breton', 'bul': 'Bulgarian', 'bur': 'Burmese', 'cat': 'Catalan', 'chi': 'Chinese (simplified)',
    'cze': 'Czech', 'dan': 'Danish', 'dut': 'Dutch', 'ell': 'Greek', 'eng': 'English', 'epo': 'Esperanto',
    'est': 'Estonian', 'ext': 'Extremaduran', 'fin': 'Finnish', 'fre': 'French', 'geo': 'Georgian',
    'ger': 'German', 'gla': 'Gaelic', 'gle': 'Irish', 'glg': 'Galician', 'heb': 'Hebrew', 'hin': 'Hindi',
    'hrv': 'Croatian', 'hat': 'Haitian Creole', 'hun': 'Hungarian', 'ibo': 'Igbo', 'ice': 'Icelandic', 'ina': 'Interlingua',
    'ind': 'Indonesian', 'ita': 'Italian', 'jpn': 'Japanese', 'kan': 'Kannada', 'kaz': 'Kazakh',
    'khm': 'Khmer', 'kir': 'Kyrgyz', 'kor': 'Korean', 'kur': 'Kurdish', 'lav': 'Latvian',
    'lit': 'Lithuanian', 'ltz': 'Luxembourgish', 'mac': 'Macedonian', 'mal': 'Malayalam', 'mar': 'Marathi',
    'may': 'Malay', 'mne': 'Montenegrin', 'mni': 'Manipuri', 'mon': 'Mongolian', 'nav': 'Navajo',
    'nep': 'Nepali', 'nor': 'Norwegian', 'oci': 'Occitan', 'ori': 'Odia', 'per': 'Persian',
    'pob': 'Portuguese (BR)', 'pol': 'Polish', 'pom': 'Portuguese (MZ)', 'por': 'Portuguese',
    'prs': 'Dari', 'pus': 'Pushto', 'rum': 'Romanian', 'rus': 'Russian', 'sat': 'Santali', 'scc': 'Serbian',
    'sin': 'Sinhalese', 'slo': 'Slovak', 'slv': 'Slovenian', 'sme': 'Northern Sami', 'snd': 'Sindhi',
    'som': 'Somali', 'spa': 'Spanish', 'spl': 'Spanish (LA)', 'spn': 'Spanish (EU)', 'swa': 'Swahili',
    'swe': 'Swedish', 'syr': 'Syriac', 'tam': 'Tamil', 'tat': 'Tatar', 'tel': 'Telugu', 'tet': 'Tetum',
    'tgl': 'Tagalog', 'tha': 'Thai', 'tok': 'Toki Pona', 'tur': 'Turkish', 'tuk': 'Turkmen', 'ukr': 'Ukrainian',
    'urd': 'Urdu', 'uzb': 'Uzbek', 'vie': 'Vietnamese', 'wel': 'Welsh', 'wen': 'Sorbian languages',
    'zhc': 'Chinese (Cantonese)', 'zht': 'Chinese (traditional)'
};

export const browserLanguageMap: Record<string, string> = {
    'en': 'eng', 'es': 'spa', 'fr': 'fre', 'de': 'ger', 'it': 'ita',
    'pt': 'por', 'pt-br': 'pob', 'ru': 'rus', 'ja': 'jpn', 'ko': 'kor',
    'zh': 'chi', 'zh-cn': 'chi', 'zh-tw': 'zht', 'ar': 'ara', 'hi': 'hin',
    'bn': 'ben', 'pa': 'pan', 'te': 'tel', 'mr': 'mar', 'ta': 'tam',
    'gu': 'guj', 'kn': 'kan', 'ml': 'mal', 'or': 'ori', 'pl': 'pol',
    'uk': 'ukr', 'tr': 'tur', 'hu': 'hun', 'cs': 'cze', 'ro': 'rum',
    'nl': 'dut', 'sv': 'swe', 'da': 'dan', 'no': 'nor', 'fi': 'fin',
    'el': 'ell', 'th': 'tha', 'vi': 'vie', 'id': 'ind', 'ms': 'may',
    'fil': 'tgl', 'he': 'heb', 'fa': 'per', 'ur': 'urd', 'sq': 'alb',
    'ht': 'hat', 'hr': 'hrv', 'sr': 'scc', 'bg': 'bul', 'sk': 'slo', 'sl': 'slv',
    'et': 'est', 'lv': 'lav', 'lt': 'lit', 'ca': 'cat', 'eu': 'baq',
    'gl': 'glg', 'mk': 'mac', 'is': 'ice', 'cy': 'wel', 'ga': 'gle'
};

export const languageOptions = Object.entries(languageMap).map(([code, name]) => `${name} [${code}]`);

export function languageName(code: string | undefined): string {
    return (code && languageMap[code]) || code || '';
}

/** "French [fre]" → "fre"; a bare code is returned as is. */
export function parseLangCode(lang: string | undefined): string | undefined {
    if (!lang) return lang;
    const match = lang.match(/\[([^\]]+)\]$/);
    return match ? match[1] : lang;
}

// The subtitle entries and the activity page speak Hebrew (Smart-Hebrew style).
const hebrewNames: Record<string, string> = {
    'ara': 'ערבית', 'bul': 'בולגרית', 'cat': 'קטלאנית', 'chi': 'סינית', 'zht': 'סינית', 'zhc': 'קנטונזית',
    'cze': 'צ\'כית', 'dan': 'דנית', 'dut': 'הולנדית', 'ell': 'יוונית', 'eng': 'אנגלית', 'fin': 'פינית',
    'fre': 'צרפתית', 'ger': 'גרמנית', 'heb': 'עברית', 'hin': 'הינדית', 'hrv': 'קרואטית', 'hun': 'הונגרית',
    'ind': 'אינדונזית', 'ita': 'איטלקית', 'jpn': 'יפנית', 'kor': 'קוריאנית', 'nor': 'נורווגית', 'per': 'פרסית',
    'pob': 'פורטוגזית', 'pol': 'פולנית', 'por': 'פורטוגזית', 'rum': 'רומנית', 'rus': 'רוסית', 'scc': 'סרבית',
    'slo': 'סלובקית', 'slv': 'סלובנית', 'spa': 'ספרדית', 'spl': 'ספרדית', 'spn': 'ספרדית', 'swe': 'שוודית',
    'tha': 'תאית', 'tur': 'טורקית', 'ukr': 'אוקראינית', 'vie': 'וייטנאמית', 'ice': 'איסלנדית', 'est': 'אסטונית',
    'lav': 'לטבית', 'lit': 'ליטאית', 'geo': 'גאורגית', 'arm': 'ארמנית', 'alb': 'אלבנית', 'mac': 'מקדונית'
};

export function hebrewLanguageName(code: string | undefined): string {
    return (code && hebrewNames[code]) || languageName(code);
}
