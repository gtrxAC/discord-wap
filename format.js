/**
 * String formatting functions
 */

const sanitizeHtml = require('sanitize-html');
const anyAscii = require('any-ascii').default;

function sanitize(res, str) {
    if (res.locals.settings?.useAnyAscii ?? res.locals.format == "wml") {
        str = anyAscii(str);
    }
    str = sanitizeHtml(str, {allowedTags: [], disallowedTagsMode: 'recursiveEscape'});

    if (res.locals.format == "wml") {
        // WML variables
        str = str.replace(/(\s*)\$(\s*)/g, (_, preSpace, postSpace) => {
            return (preSpace || ' ') + 'dollar' + (postSpace || ' ');
        });
    }
    return str;
}

/**
 * Get an approximation of how many characters can fit on one line on the requester's device's display.
 * @param {express.Request} req The express request to check
 * @returns A rough and somewhat conservative estimate of how many columns the user's device's screen has
 */
function getCharactersPerLine(req, res) {
    const ua = req.headers['user-agent'];
    if (!ua) return 16;

    // siemens: assume 101 pixel wide display (there are larger ones too, but most of them have decent j2me support anyway)
    // small font size, tested on siemens a65. a55 seems to use the same font
    // for medium font size, a suitable number would be 15
    if (ua.startsWith('SIE-')) return 18;
    
    // could check some non-nokia models, for now, make a safe assumption of 16 chars
    // could also use uaprof on devices that have that
    if (!ua.startsWith('Nokia')) return 16;

    // models with 84×48 display
    if (/^Nokia(3330|5510|8265|8310)/.test(ua)) return 16;

    // models with 96×65 or similar display (list may be incomplete)
    if (/^Nokia(1101|3350|3410|35[^0]\d|3610|6010|6210|6310|6510|7110|8910)/.test(ua)) return 19;

    // other nokias when in WML mode, assume older WML-only browser with larger font size, e.g. Nokia 6100
    if (res.locals.format == "wml") return 16;

    // other nokias when in HTML mode, assume a 128×128 or 128×160 display with smaller font
    return 21;
}

/**
 * Get the best way to break apart long words on the user's browser
 */
function getWordBreakMethod(req) {
    const ua = (req.headers["user-agent"] ?? '').toLowerCase();

    if (ua.includes('webkit') || ua.includes('gecko/2010')) {
        return 'css';  // "word-wrap: break-word" (any webkit, or firefox from ~2009 onwards)
    }
    if (ua.startsWith('sonyericsson') && /midp-1/.test(ua)) {
        return 'none';  // word break automatically handled by browser (T610, T630, Z600)
    }
    return 'shy';  // place &shy; entities within long words (may be unsupported)
}

function placeWordBreaks(str) {
    // match long words, at least 16 consecutive letters
    return str.replace(/([^\s]{16,})/g, (match) => {
        let result = '';
        let canPlace = true;
        
        match.split('').forEach((chr, i) => {
            result += chr;

            // don't break apart other html entities
            if (chr == '&') canPlace = false;
            else if (chr == ';') canPlace = true;

            // place word break opportunities every 4 characters starting from char position 12 if there are at least 2 more chars left to go
            if (canPlace && (i + 1) % 4 == 0 && i >= 11 && str.length > (i + 2)) result += "&shy;";
        })
        return result;
    })
}

// In views, strings must be formatted in any of the following ways:
// <%= var %>  normal HTML sanitize (do not use for user inputs in WML)
// <%- sanitize(var) %>  safer sanitize for WML
// <%- fit(var) %>  sanitize and place zero-width spaces to prevent page width from increasing due to long words
// <%- oneLine(var) %>  sanitize and truncate string to fit on one line on the screen

function fit(req, res, str) {
    str = sanitize(res, str);

    if (res.locals.wordBreakMethod == 'shy') {
        str = placeWordBreaks(str);
    }
    str = str.replace(/\n/g, "<br/>");
    return str;
}

/**
 * Make sure string fits on one line on the screen, truncate with ... at the end
 */
function oneLine(req, res, str, charsUsed = 0) {
    str = sanitize(res, str);

    if (!res.locals.theme.oneLineTruncate) return str;

    const chars = getCharactersPerLine(req, res) - charsUsed;

    if (str.length > chars) return str.substring(0, chars - 1).trimEnd() + "...";
    return str;
}

function stringFormatMiddleware(req, res, next) {
    res.locals.wordBreakMethod = getWordBreakMethod(req);

    res.locals.sanitize = (str) => sanitize(res, str);
    res.locals.fit = (str) => fit(req, res, str);
    res.locals.oneLine = (str, charsUsed) => oneLine(req, res, str, charsUsed);
    next();
}

module.exports = stringFormatMiddleware;