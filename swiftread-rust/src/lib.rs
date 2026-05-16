use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

/// Extract plain text from a PDF byte slice.
/// Returns an empty string on failure; JS checks for that and shows an error.
#[wasm_bindgen]
pub fn extract_pdf_text(bytes: &[u8]) -> String {
    pdf_extract::extract_text_from_mem(bytes).unwrap_or_default()
}

// ================================================================
// TYPES
// ================================================================

// Input: JS DOM walker produces flat segments, one per text node / code block / table.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    #[serde(rename = "type")]
    seg_type: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    is_link: bool,
    #[serde(default)]
    html: Option<String>,
}

// Output: tokens returned to JS for display. String fields are always serialized
// (empty string instead of `undefined`) so the JS consumer can read them without
// per-field guards.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Token {
    #[serde(rename = "type")]
    token_type: String,
    text: String,
    before: String,
    orp: String,
    after: String,
    is_link: bool,
    ctx: Option<TokenCtx>,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<String>,
}

#[derive(Serialize, Clone)]
struct TokenCtx {
    open: String,
    close: String,
}

// ================================================================
// PUNCTUATION HELPERS
// ================================================================

// Mirrors the JS LEADING_PUNCT and TRAILING_PUNCT regexes.
fn is_leading_punct(c: char) -> bool {
    matches!(
        c,
        '(' | '[' | '{' | '"' | '\'' | '«' | '‹'
            | '\u{201C}' // "
            | '\u{2018}' // '
            | '`'
    )
}

fn is_trailing_punct(c: char) -> bool {
    matches!(
        c,
        ')' | ']' | '}' | '"' | '\'' | '»' | '›'
            | '\u{201D}' // "
            | '\u{2019}' // '
            | '`'
            | '.' | ',' | ';' | ':' | '!' | '?'
            | '\u{2026}' // …
    )
}

// ================================================================
// TOKEN BUILDING
// ================================================================

fn make_word_token(word: &str, is_link: bool) -> Token {
    // Count leading/trailing punct bytes (not chars — we need byte offsets for slicing).
    let lead_bytes: usize = word
        .char_indices()
        .take_while(|(_, c)| is_leading_punct(*c))
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);

    let trail_bytes: usize = word
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_trailing_punct(*c))
        .last()
        .map(|(i, _)| word.len() - i)
        .unwrap_or(0);

    let core = if lead_bytes + trail_bytes < word.len() {
        &word[lead_bytes..word.len() - trail_bytes]
    } else {
        word
    };

    let target = if core.is_empty() { word } else { core };
    let char_count = target.chars().count();
    let orp_char_idx = ((char_count as f64 * 0.35).floor() as usize)
        .min(char_count.saturating_sub(1));

    let (orp_start, orp_end) = {
        let mut s = 0;
        let mut e = target.len();
        for (n, (i, c)) in target.char_indices().enumerate() {
            if n == orp_char_idx {
                s = i;
                e = i + c.len_utf8();
                break;
            }
        }
        (s, e)
    };

    let lead_str = &word[..lead_bytes];
    let trail_str = if trail_bytes > 0 {
        &word[word.len() - trail_bytes..]
    } else {
        ""
    };

    let before_core = &target[..orp_start];
    let orp_char = &target[orp_start..orp_end];
    let after_core = &target[orp_end..];

    let orp = if orp_char.is_empty() {
        target
            .chars()
            .next()
            .or_else(|| word.chars().next())
            .map(|c| c.to_string())
            .unwrap_or_default()
    } else {
        orp_char.to_string()
    };

    Token {
        token_type: "word".to_string(),
        text: word.to_string(),
        before: format!("{}{}", lead_str, before_core),
        orp,
        after: format!("{}{}", after_core, trail_str),
        is_link,
        ctx: None,
        html: None,
    }
}

// ================================================================
// BRACKET / QUOTE CONTEXT ANNOTATION
// ================================================================

// Only unambiguous open→close pairs. Straight ' and " are omitted because
// they appear in contractions and cannot be paired reliably.
const CTX_PAIRS: &[(char, char)] = &[
    ('(', ')'),
    ('[', ']'),
    ('{', '}'),
    ('\u{201C}', '\u{201D}'), // " → "
    ('\u{2018}', '\u{2019}'), // ' → '
    ('«', '»'),
    ('‹', '›'),
];

fn annotate_context(tokens: &mut Vec<Token>) {
    // (open, close) chars — avoids per-push String allocation.
    let mut stack: Vec<(char, char)> = Vec::new();

    for token in tokens.iter_mut() {
        if token.token_type == "word" {
            let chars: Vec<char> = token.text.chars().collect();
            let lead_count = chars.iter().take_while(|&&c| is_leading_punct(c)).count();
            let trail_count = chars.iter().rev().take_while(|&&c| is_trailing_punct(c)).count();

            for &ch in &chars[..lead_count] {
                if let Some(&(_, close)) = CTX_PAIRS.iter().find(|&&(open, _)| open == ch) {
                    stack.push((ch, close));
                }
            }

            token.ctx = stack.last().map(|&(o, c)| TokenCtx {
                open: o.to_string(),
                close: c.to_string(),
            });

            let trail_start = chars.len().saturating_sub(trail_count);
            for &ch in chars[trail_start..].iter().rev() {
                if let Some(&(_, close)) = stack.last() {
                    if close == ch {
                        stack.pop();
                    }
                }
            }
        } else {
            token.ctx = stack.last().map(|&(o, c)| TokenCtx {
                open: o.to_string(),
                close: c.to_string(),
            });
        }
    }
}

// ================================================================
// PUBLIC API
// ================================================================

/// Convert an array of DOM segments into an array of display tokens.
/// Zero-copy via serde-wasm-bindgen: JS passes/receives plain JS objects.
#[wasm_bindgen]
pub fn build_tokens(segments: JsValue) -> Result<JsValue, JsValue> {
    let segments: Vec<Segment> = serde_wasm_bindgen::from_value(segments)
        .map_err(|e| JsValue::from_str(&format!("invalid segments: {}", e)))?;

    let mut tokens: Vec<Token> = Vec::with_capacity(segments.len() * 4);

    for seg in &segments {
        match seg.seg_type.as_str() {
            "text" => {
                for word in seg.text.split_whitespace() {
                    tokens.push(make_word_token(word, seg.is_link));
                }
            }
            "code" => {
                let text = seg.text.trim().to_string();
                if !text.is_empty() {
                    tokens.push(Token {
                        token_type: "code".to_string(),
                        text,
                        ..Default::default()
                    });
                }
            }
            "table" => {
                if let Some(html) = &seg.html {
                    tokens.push(Token {
                        token_type: "table".to_string(),
                        html: Some(html.clone()),
                        ..Default::default()
                    });
                }
            }
            _ => {}
        }
    }

    annotate_context(&mut tokens);

    serde_wasm_bindgen::to_value(&tokens)
        .map_err(|e| JsValue::from_str(&format!("serialize failed: {}", e)))
}

/// Compute how long (ms) to display a word given the current speed settings.
/// Called on every tick so live slider/key changes take effect immediately.
#[wasm_bindgen]
pub fn word_duration(
    word: &str,
    wpm: f64,
    char_penalty_ms: f64,
    hyphen_multiplier: f64,
    min_duration_ms: f64,
    max_duration_ms: f64,
) -> f64 {
    let base = 60_000.0 / wpm;
    let chars = word.chars().filter(|c| c.is_alphanumeric()).count() as f64;
    let extra_chars = (chars - 5.0).max(0.0);
    let mut duration = base + extra_chars * char_penalty_ms;

    let stripped_len = word.chars().filter(|&c| c != '-').count();
    if word.contains('-') && stripped_len > 3 {
        duration *= hyphen_multiplier;
    }

    duration.clamp(min_duration_ms, max_duration_ms)
}
