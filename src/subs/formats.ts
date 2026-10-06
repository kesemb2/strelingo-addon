// Subtitle formats: everything is converted to SRT text, then parsed into cues.
// The converters come from the original Strelingo add-on.

import SRTParser2 from 'srt-parser-2';
import type { SubtitleCue } from '../subtitleMatching';

type SRTLine = SubtitleCue;

export const SubtitleConverter = {
    toTimeString(ms: number): string {
        const hh = Math.floor(ms / 1000 / 3600);
        const mm = Math.floor(ms / 1000 / 60 % 60);
        const ss = Math.floor(ms / 1000 % 60);
        const ff = Math.floor(ms % 1000);
        return (hh < 10 ? "0" : "") + hh + ":" +
            (mm < 10 ? "0" : "") + mm + ":" +
            (ss < 10 ? "0" : "") + ss + "," +
            (ff < 100 ? "0" : "") + (ff < 10 ? "0" : "") + ff;
    },
    htmlDecode(html: string): string {
        return html.replace(/&nbsp;/g, ' ')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    },
    buildSrt(captions: any[]): string {
        let srt = "";
        for (let i = 0; i < captions.length; i++) {
            const caption = captions[i];
            if (!caption.text) continue;
            srt += (i + 1).toString() + "\n";
            srt += this.toTimeString(caption.start) + " --> " + this.toTimeString(caption.end) + "\n";
            srt += caption.text + "\n\n";
        }
        return srt;
    },
    parseVttToMs(s: string): number {
        const match = /^\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?\s*$/.exec(s);
        if (!match) return 0;
        const hh = match[1] ? parseInt(match[1].replace(":", "")) : 0;
        const mm = parseInt(match[2]);
        const ss = parseInt(match[3]);
        const ff = match[5] ? parseInt(match[5]) : 0;
        return hh * 3600 * 1000 + mm * 60 * 1000 + ss * 1000 + ff;
    },
    parseVtt(content: string): any[] {
        const captions = [];
        const parts = content.split(/\r?\n\s+\r?\n/);
        for (let i = 0; i < parts.length; i++) {
            const regex = /^([^\r\n]+\r?\n)?((\d{1,2}:)?\d{1,2}:\d{1,2}([.,]\d{1,3})?)\s*\-\-\>\s*((\d{1,2}:)?\d{1,2}:\d{1,2}([.,]\d{1,3})?)\r?\n([\s\S]*)(\r?\n)*$/gi;
            const match = regex.exec(parts[i]);
            if (match) {
                const text = match[8].split(/\r?\n/).join("\n").replace(/\<[^\>]+\>/g, "").replace(/\{[^\}]+\}/g, "");
                captions.push({ start: this.parseVttToMs(match[2]), end: this.parseVttToMs(match[5]), text });
            }
        }
        return captions;
    },
    parseSsaToMs(s: string): number {
        const match = /^\s*(\d+:)?(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?\s*$/.exec(s);
        if (!match) return 0;
        const hh = match[1] ? parseInt(match[1].replace(":", "")) : 0;
        const mm = parseInt(match[2]);
        const ss = parseInt(match[3]);
        const ff = match[5] ? parseInt(match[5]) : 0;
        return hh * 3600 * 1000 + mm * 60 * 1000 + ss * 1000 + ff * 10;
    },
    parseSsa(content: string): any[] {
        const captions = [];
        let columns: string[] = [];
        const parts = content.split(/\r?\n\s*\r?\n/);
        for (let i = 0; i < parts.length; i++) {
            const match = /^\s*\[([^\]]+)\]\r?\n([\s\S]*)(\r?\n)*$/gi.exec(parts[i]);
            if (match) {
                const tag = match[1];
                const lines = match[2].split(/\r?\n/);
                for (let l = 0; l < lines.length; l++) {
                    const line = lines[l];
                    if (/^\s*;/.test(line)) continue;
                    const m = /^\s*([^:]+):\s*(.*)(\r?\n)?$/.exec(line);
                    if (m && (tag === "V4 Styles" || tag === "V4+ Styles" || tag === "Events")) {
                        const name = m[1].trim();
                        const value = m[2].trim();
                        if (name === "Format") {
                            columns = value.split(/\s*,\s*/g);
                        } else if (name === "Dialogue" && columns.length > 0) {
                            const values = value.split(/\s*,\s*/g);
                            const data: any = {};
                            for (let c = 0; c < columns.length - 1 && c < values.length; c++) {
                                data[columns[c]] = values[c];
                            }
                            const getPosition = (s: string, search: string, index: number) => s.split(search, index).join(search).length;
                            const indexOfText = getPosition(value, ',', columns.length - 1) + 1;
                            let textContent = value.substring(indexOfText);
                            textContent = textContent.replace(/\\N/gi, "\n").replace(/\{[^\}]+\}/g, "");
                            captions.push({
                                start: this.parseSsaToMs(data["Start"]),
                                end: this.parseSsaToMs(data["End"]),
                                text: textContent
                            });
                        }
                    }
                }
            }
        }
        return captions;
    },
    parseSbvToMs(s: string): number {
        const match = /^\s*(\d{1,2}):(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?\s*$/.exec(s);
        if (!match) return 0;
        const hh = parseInt(match[1]);
        const mm = parseInt(match[2]);
        const ss = parseInt(match[3]);
        const ff = match[5] ? parseInt(match[5]) : 0;
        return hh * 3600 * 1000 + mm * 60 * 1000 + ss * 1000 + ff;
    },
    parseSbv(content: string): any[] {
        const captions = [];
        const parts = content.split(/\r?\n\s+\r?\n/);
        for (let i = 0; i < parts.length; i++) {
            const regex = /^(\d{1,2}:\d{1,2}:\d{1,2}([.,]\d{1,3})?)\s*[,;]\s*(\d{1,2}:\d{1,2}:\d{1,2}([.,]\d{1,3})?)\r?\n([\s\S]*)(\r?\n)*$/gi;
            const match = regex.exec(parts[i]);
            if (match) {
                const text = match[5].split(/\[br\]|\r?\n/gi).join("\n").replace(/\>\>\s*[^:]+:\s*/g, "");
                captions.push({ start: this.parseSbvToMs(match[1]), end: this.parseSbvToMs(match[3]), text });
            }
        }
        return captions;
    },
    parseSmi(content: string): any[] {
        const captions = [];
        const sami = content.replace(/^[\s\S]*\<BODY[^\>]*\>/gi, "").replace(/\<\/BODY[^\>]*\>[\s\S]*$/gi, "");
        let prev = null;
        const parts = sami.split(/\<SYNC/gi);
        for (let i = 0; i < parts.length; i++) {
            if (!parts[i] || parts[i].trim().length == 0) continue;
            const match = /^\<SYNC[^\>]+Start\s*=\s*["']?(\d+)["']?[^\>]*\>([\s\S]*)/gi.exec('<SYNC' + parts[i]);
            if (match) {
                const start = parseInt(match[1]);
                let contentText = match[2].replace(/^\<\/SYNC[^\>]*>/gi, "");
                let p = /^\<P[^\>]+Class\s*=\s*["']?([\w\d\-_]+)["']?[^\>]*\>([\s\S]*)/gi.exec(contentText);
                if (!p) p = /^\<P([^\>]*)\>([\s\S]*)/gi.exec(contentText);
                let html = p ? p[2] : contentText;
                html = html.replace(/\<P[\s\S]+$/gi, "");
                html = html.replace(/\<BR\s*\/?\>[\s\r\n]+/gi, "\n").replace(/\<BR\s*\/?\>/gi, "\n").replace(/\<[^\>]+\>/g, "");
                html = html.replace(/^[\s\r\n]+/g, "").replace(/[\s\r\n]+$/g, "");
                const blank = (html.replace(/&nbsp;/gi, " ").replace(/[\s\r\n]+/g, "").length == 0);
                html = this.htmlDecode(html);
                const caption = { start, end: start + 2000, text: html };
                if (prev) prev.end = caption.start;
                if (!blank) captions.push(caption);
                prev = blank ? null : caption;
            }
        }
        return captions;
    },
    parseSub(content: string, fps = 23.976): any[] {
        const captions = [];
        const parts = content.split(/\r?\n/g);
        for (let i = 0; i < parts.length; i++) {
            const match = /^\{(\d+)\}\{(\d+)\}(.*)$/gi.exec(parts[i]);
            if (match) {
                const text = match[3].split(/\|/g).join("\n").replace(/\{[^\}]+\}/g, "");
                captions.push({
                    start: Math.round((parseInt(match[1]) / fps) * 1000),
                    end: Math.round((parseInt(match[2]) / fps) * 1000),
                    text
                });
            }
        }
        return captions;
    },
    parseLrcToMs(s: string): number {
        const match = /^\s*(\d+):(\d{1,2})([.,](\d{1,3}))?\s*$/.exec(s);
        if (!match) return 0;
        const mm = parseInt(match[1]);
        const ss = parseInt(match[2]);
        const ff = match[4] ? parseInt(match[4]) : 0;
        return mm * 60 * 1000 + ss * 1000 + ff * 10;
    },
    parseLrc(content: string): any[] {
        const captions = [];
        let prev = null;
        const parts = content.split(/\r?\n/);
        for (let i = 0; i < parts.length; i++) {
            if (!parts[i] || parts[i].trim().length == 0) continue;
            const match = /^\[(\d{1,2}:\d{1,2}([.,]\d{1,3})?)\](.*)(\r?\n)*$/gi.exec(parts[i]);
            if (match) {
                const start = this.parseLrcToMs(match[1]);
                const caption = { start, end: start + 2000, text: match[3] };
                if (prev) prev.end = caption.start;
                captions.push(caption);
                prev = caption;
            }
        }
        return captions;
    },
    parseTtmlToMs(s: string): number {
        const match = /^\s*(\d{1,2}):(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?\s*$/.exec(s);
        if (match) {
            const hh = parseInt(match[1]);
            const mm = parseInt(match[2]);
            const ss = parseInt(match[3]);
            const ff = match[5] ? parseInt(match[5]) : 0;
            return hh * 3600 * 1000 + mm * 60 * 1000 + ss * 1000 + ff;
        }
        return 0;
    },
    parseTtml(content: string): any[] {
        const captions = [];
        const pRegex = /\<p\s+[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*\>([\s\S]*?)\<\/p\>/gi;
        let match;
        while ((match = pRegex.exec(content)) !== null) {
            const start = this.parseTtmlToMs(match[1]);
            const end = this.parseTtmlToMs(match[2]);
            let text = match[3].replace(/\<br\s*\/?\>/gi, "\n").replace(/\<[^\>]+\>/g, "");
            text = this.htmlDecode(text).trim();
            captions.push({ start, end, text });
        }
        return captions;
    },
    convert(text: string, format: string): string | null {
        const f = format.toLowerCase().trim();
        if (f === 'srt') return text;
        try {
            let captions: any[] = [];
            if (f === 'sub') captions = this.parseSub(text);
            else if (f === 'vtt') captions = this.parseVtt(text);
            else if (f === 'ssa' || f === 'ass') captions = this.parseSsa(text);
            else if (f === 'sbv') captions = this.parseSbv(text);
            else if (f === 'smi') captions = this.parseSmi(text);
            else if (f === 'lrc') captions = this.parseLrc(text);
            else if (f === 'dfxp' || f === 'ttml') captions = this.parseTtml(text);

            if (captions.length > 0) return this.buildSrt(captions);
        } catch (e: any) {
            console.error(`[convert] ${format} failed:`, e.message);
        }
        return null;
    }
};

// Formats an array of subtitle objects back into SRT text
export function formatSrt(subtitleArray: SRTLine[]): string | null {
    if (!Array.isArray(subtitleArray)) {
        console.error("Invalid input to formatSrt: not an array.");
        return null;
    }
    try {
        return subtitleArray
            .filter(sub => sub.text && sub.text.trim())
            .map((sub, index) => `${index + 1}\n${sub.startTime} --> ${sub.endTime}\n${sub.text.trim()}\n`)
            .join('\n');
    } catch (error: any) {
        console.error('Error formatting SRT:', error.message);
        console.error('Problematic data for formatSrt:', JSON.stringify(subtitleArray.slice(0, 5)));
        return null;
    }
}

// Parses SRT text into an array of objects
export function parseSrt(srtText: string): SRTLine[] | null {
    if (!srtText || typeof srtText !== 'string') {
        console.error("Invalid input to parseSrt: not a string or empty.");
        return null;
    }
    try {
        const parser = new SRTParser2();
        if (srtText.charCodeAt(0) === 0xFEFF) {
            srtText = srtText.substring(1);
        }
        srtText = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        let subtitles = parser.fromSrt(srtText);

        if (!Array.isArray(subtitles)) {
            console.error("Parsing did not return an array.");
            return null;
        }

        const adKeywords = ["OpenSubtitles.org", "OpenSubtitles.com", "osdb.link"];
        const originalCount = subtitles.length;
        subtitles = subtitles.filter(sub =>
            !adKeywords.some(keyword => sub.text.includes(keyword))
        );

        if (originalCount > subtitles.length) {
            console.log(`[adblock] removed ${originalCount - subtitles.length} ad line(s)`);
        }

        if (subtitles.length === 0 && srtText.trim().length > 0) {
            console.warn("[parse] empty result despite non-empty input");
            return null;
        }

        if (subtitles.length > 0 && (!subtitles[0].startTime || !subtitles[0].text)) {
            console.warn("[parse] invalid structure (missing startTime or text)");
            return null;
        }

        return subtitles as SRTLine[];
    } catch (error: any) {
        console.error('Error parsing SRT:', error.message);
        return null;
    }
}
