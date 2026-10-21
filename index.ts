/**
 * pi-youtube-transcript-plus
 *
 * Thin wrapper around `youtube-transcript-plus`. The library fetches the
 * complete transcript; this extension adds what a coding agent actually needs:
 *
 *   - the full transcript written to a markdown file in the OS temp directory
 *   - only a timestamped preview returned into the context window
 *   - a path the agent can keep reading with the `read` tool
 *
 * Files live next to pi's other output files (see utils/output-files.ts there):
 * `<tmpdir>/pi-yttp-<videoId>.md`, mode 0600, ephemeral by design.
 *
 * Env:
 *   PI_YT_TRANSCRIPT_DIR  output directory (default: os.tmpdir())
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchTranscript, type TranscriptSegment, type VideoDetails } from "youtube-transcript-plus";

/** Same temp directory pi uses for output it does not show the model in full. */
const DEFAULT_DIR = process.env.PI_YT_TRANSCRIPT_DIR || tmpdir();
/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;
const DEFAULT_MAX_CHARS = 24_000;
/** how many seconds of speech to merge into one timestamped line */
const BUCKET_SEC = 10;

/* ---------------------------------------------------------------- helpers */

function normalizeVideoId(input: string): string {
	const value = String(input ?? "").trim();
	if (!value) throw new Error("Empty YouTube URL or video id");
	if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

	const patterns = [
		/[?&]v=([A-Za-z0-9_-]{11})/,
		/youtu\.be\/([A-Za-z0-9_-]{11})/,
		/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		if (match) return match[1];
	}
	throw new Error(`Could not find a YouTube video id in: ${input}`);
}

function formatTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&amp;/g, "&");
}

function clean(segments: TranscriptSegment[]): TranscriptSegment[] {
	return segments
		.map((segment) => ({ ...segment, text: decodeEntities(segment.text).replace(/\s+/g, " ").trim() }))
		.filter((segment) => segment.text.length > 0);
}

function renderTimestamped(segments: TranscriptSegment[]): string {
	const lines: { t: number; text: string }[] = [];
	for (const segment of segments) {
		const last = lines[lines.length - 1];
		if (last && segment.offset - last.t < BUCKET_SEC) last.text = `${last.text} ${segment.text}`;
		else lines.push({ t: segment.offset, text: segment.text });
	}
	return lines.map((line) => `[${formatTime(line.t)}] ${line.text}`).join("\n");
}

function renderPlain(segments: TranscriptSegment[]): string {
	return segments.map((segment) => segment.text).join(" ");
}

function buildMarkdown(
	video: VideoDetails,
	segments: TranscriptSegment[],
	language: string,
	transcript: string,
): string {
	const header = [
		"---",
		`title: ${JSON.stringify(video.title ?? "")}`,
		`channel: ${JSON.stringify(video.author ?? "")}`,
		`channel_id: ${video.channelId ?? ""}`,
		`url: https://www.youtube.com/watch?v=${video.videoId}`,
		`duration: ${formatTime(video.lengthSeconds ?? 0)}`,
		`duration_sec: ${video.lengthSeconds ?? 0}`,
		`views: ${video.viewCount ?? 0}`,
		`language: ${language}`,
		`segments: ${segments.length}`,
		`extracted: ${new Date().toISOString().slice(0, 10)}`,
		"---",
		"",
	];
	const body: string[] = [];
	if (video.description?.trim()) body.push("## Description", "", video.description.trim(), "");
	body.push("## Transcript", "", transcript, "");
	return [...header, ...body].join("\n");
}

/** Try the requested language, then English, then whatever the video has. */
async function loadTranscript(videoId: string, language: string, signal?: AbortSignal) {
	const attempts = [...new Set([language.toLowerCase(), "en"])];
	let lastError: unknown;

	for (const lang of [...attempts, undefined]) {
		try {
			const result = await fetchTranscript(videoId, {
				...(lang ? { lang } : {}),
				videoDetails: true,
				retries: 1,
				...(signal ? { signal } : {}),
			});
			const segments = clean(result.segments);
			if (segments.length > 0) {
				return { video: result.videoDetails, segments, requested: language.toLowerCase(), got: lang ?? "auto" };
			}
			lastError = new Error(`Transcript for "${lang ?? "auto"}" came back empty`);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/* ------------------------------------------------------------- extension */

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "youtube_transcript",
		label: "YouTube Transcript",
		description:
			"Fetch the complete transcript of a YouTube video, save it to a markdown file, and return a timestamped preview. " +
			"Use it whenever the user shares a YouTube link and asks about its content — do not ask them to paste the transcript. " +
			"The full text is always on disk (the response names the path), so read that file with offset/limit when you need more than the preview. " +
			"A non-default language may return YouTube's auto-translated captions, which are machine translations rather than the original speech.",
		promptSnippet: "Fetch a YouTube transcript; saves the full text to a file and returns a timestamped preview",
		promptGuidelines: [
			"Use youtube_transcript when the user asks about the content of a YouTube video, or shares a YouTube URL without saying what they want from it.",
			"The tool returns only a preview. For long videos, continue with the read tool on the saved file instead of re-fetching.",
			"Pass format=\"plain\" only when timestamps are irrelevant (e.g. summarizing).",
			"When quoting a speaker verbatim, fetch the spoken language (usually en). Other languages come from YouTube auto-translation and are not the speaker's words.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "YouTube URL (watch, youtu.be, shorts, embed, live) or an 11-character video id",
			}),
			language: Type.Optional(
				Type.String({ description: "Preferred caption language code, e.g. \"en\" or \"ru\"", default: "en" }),
			),
			format: Type.Optional(
				Type.Union([Type.Literal("timestamped"), Type.Literal("plain")], {
					description: "timestamped = one line per ~10s (default), plain = one paragraph",
					default: "timestamped",
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: `Characters of transcript to return in this response (default ${DEFAULT_MAX_CHARS}); the rest stays in the saved file`,
				}),
			),
			save: Type.Optional(
				Type.Boolean({ description: "Write the full transcript to a markdown file (default true)" }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const videoId = normalizeVideoId(params.url);
			const language = (params.language || "en").toLowerCase();
			const { video, segments, got } = await loadTranscript(videoId, language, signal);

			const timestamped = renderTimestamped(segments);
			const rendered = params.format === "plain" ? renderPlain(segments) : timestamped;
			const detectedLanguage = segments[0]?.lang ?? got;

			let filePath = "";
			if (params.save !== false) {
				await mkdir(DEFAULT_DIR, { recursive: true });
				filePath = join(DEFAULT_DIR, `pi-yttp-${videoId}.md`);
				await writeFile(filePath, buildMarkdown(video, segments, detectedLanguage, timestamped), {
					mode: OUTPUT_FILE_MODE,
				});
			}

			const max = Math.max(500, Math.floor(params.maxChars ?? DEFAULT_MAX_CHARS));
			let transcript = rendered;
			let truncated = false;
			if (transcript.length > max) {
				const cut = transcript.lastIndexOf("\n", max);
				transcript = transcript.slice(0, cut > 0 ? cut : max).trimEnd();
				truncated = true;
			}

			const mismatch = detectedLanguage.toLowerCase() !== language;
			const header = [
				`Title: ${video.title || "(unknown)"}`,
				`Channel: ${video.author || "(unknown)"}`,
				`Duration: ${formatTime(video.lengthSeconds ?? 0)}`,
				`Language: ${detectedLanguage}${mismatch ? ` (requested "${language}")` : ""}`,
				`Segments: ${segments.length}`,
				`URL: https://www.youtube.com/watch?v=${videoId}`,
			].join("\n");

			const footer: string[] = [];
			if (truncated) {
				footer.push(
					`[returned ${transcript.length} of ${rendered.length} characters]` +
						(filePath ? ` Full transcript: ${filePath} — continue with the read tool (offset/limit).` : ""),
				);
			} else if (filePath) {
				footer.push(`Full transcript saved: ${filePath}`);
			}

			const text = [header, "", transcript, ...(footer.length ? ["", ...footer] : [])].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					videoId,
					title: video.title,
					author: video.author,
					durationSec: video.lengthSeconds,
					views: video.viewCount,
					language: detectedLanguage,
					segments: segments.length,
					charCount: rendered.length,
					filePath,
					truncated,
				},
			};
		},
	});
}
