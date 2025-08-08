const express = require('express');
const axios = require('axios');
const EmojiConvertor = require('emoji-js');
const path = require('path');
const { LRUCache } = require('lru-cache');
const sanitizeHtml = require('sanitize-html');
const cookieParser = require('cookie-parser');

const emoji = new EmojiConvertor();
emoji.replace_mode = 'unified';

const app = express();
const PORT = 8008;
const DEST_BASE = "https://discord.com/api/v9";

app.set('view engine', 'ejs');
app.set('views', './views');

app.use(express.static(path.join(__dirname, 'static')));
app.use(express.urlencoded({ extended: true }));

// ID -> username mapping cache (used for parsing mentions)
const userCache = new LRUCache({max: 10000});
const channelNameCache = new LRUCache({max: 10000});

// Base64 but better - instead of '/' and '=' characters, we use '-' and '_', which stay as one character when URL encoded
function customBase64Decode(str) {
    return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}
function customBase64Encode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function decompressID(id) {
    const idStr = customBase64Decode(id);

    return String(
        BigInt(idStr.charCodeAt(0)) << 56n |
        BigInt(idStr.charCodeAt(1)) << 48n |
        BigInt(idStr.charCodeAt(2)) << 40n |
        BigInt(idStr.charCodeAt(3)) << 32n |
        BigInt(idStr.charCodeAt(4)) << 24n |
        BigInt(idStr.charCodeAt(5)) << 16n |
        BigInt(idStr.charCodeAt(6)) << 8n |
        BigInt(idStr.charCodeAt(7))
    );
}

function compressID(id) {
    id = BigInt(id);

    const arr = [
        Number(id >> 56n),
        Number((id >> 48n) & 0xFFn),
        Number((id >> 40n) & 0xFFn),
        Number((id >> 32n) & 0xFFn),
        Number((id >> 24n) & 0xFFn),
        Number((id >> 16n) & 0xFFn),
        Number((id >> 8n) & 0xFFn),
        Number(id & 0xFFn),
    ];
    return customBase64Encode(String.fromCharCode(...arr))
}

function decompressToken(token) {
    if (!token || !token.trim().length) throw new Error("Token not specified");

    try {
        let idPart = token.split('.')[0];
        const rest = '.' + token.split('.').slice(1).join('.');
    
        if (idPart.length < 17) {
            idPart = btoa(decompressID(idPart));
        }
        return idPart + rest;
    }
    catch (e) {
        throw new Error("Token is invalid");
    }
}

function compressToken(token) {
    if (!token || !token.trim().length) throw new Error("Token not specified");

    try {
        let idPart = token.split('.')[0];
        const rest = '.' + token.split('.').slice(1).join('.');
        
        if (idPart.length >= 17) {
            idPart = compressID(atob(idPart));
        }
        return idPart + rest;
    }
    catch (e) {
        throw new Error("Token is invalid");
    }
}

function getIdTimestamp(res, id) {
    if (!id) return "N/A";

    const date = new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
    date.setHours(date.getHours() + res.locals.settings.timeOffsetHours);
    date.setMinutes(date.getMinutes() + res.locals.settings.timeOffsetMinutes);

    const now = new Date();
    now.setHours(now.getHours() + res.locals.settings.timeOffsetHours);
    now.setMinutes(now.getMinutes() + res.locals.settings.timeOffsetMinutes);

    if (date.getDate() == now.getDate() && date.getMonth() == now.getMonth() && date.getFullYear() == now.getFullYear()) {
        // today -> show the time
        let period = '';

        if (res.locals.settings.use12hTime) {
            period = date.getHours() < 12 ? "A" : "P";
    
            // Convert hours to 12-hour format
            date.setHours(date.getHours() % 12);
            if (date.getHours() == 0) {
                date.setHours(12);
            }
        }
    
        let minutes = date.getMinutes();
        if (minutes < 10) minutes = '0' + minutes;
    
        return date.getHours() + ":" + minutes + period;
    } else {
        // not today -> show the date
        let day = date.getDate();
        if (day < 10) day = '0' + day;

        let month = date.getMonth() + 1;
        if (month < 10) month = '0' + month;

        return day + "/" + month;
    }
}

/**
 * Get an approximation of how many characters can fit on one line on the requester's device's display.
 * @param {express.Request} req The express request to check
 * @returns A rough and somewhat conservative estimate of how many columns the user's device's screen has
 */
function getCharactersPerLine(req) {
    const ua = req.headers['user-agent'];
    if (!ua) return 16;

    // don't limit on modern devices
    if (req.res.locals.format == "html") return 999;

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

    // other nokias, assume a 128×128 or 128×160 display
    return 21;
}

function oneLine(req, str, showEmoji = true) {
    // Make sure string fits on one line on the screen
    if (str === null || str === undefined) return "(err)";

    if (showEmoji) str = parseMessageContentText(String(str));
    else str = sanitize(String(str));

    const chars = getCharactersPerLine(req);

    if (str.length > chars) return str.substring(0, chars - 1).trimEnd() + "...";
    return str;
}

function getError(e) {
    if (!e.message) return e.toString();

    if (e.message == "Request failed with status code 401") {
        return "Authentication failed. Make sure the token is valid and entered correctly."
    }
    if (e.message == "Request failed with status code 403") {
        return "Access denied. Make sure you have permission to access this channel."
    }
    if (e.message == "Request failed with status code 404") {
        return "The channel was not found."
    }
    if (e.message == "The string to be decoded is not correctly encoded.") {
        return "We've updated our ID encoding scheme. Please return to the Discord WAP front page and try again."
    }
    return e.message;
}

function handleError(res, e) {
    console.log(e);
    render(res, "error", {error: getError(e)});
}

function sanitize(str) {
    return sanitizeHtml(str, {allowedTags: [], disallowedTagsMode: 'recursiveEscape'});
}

function parseMessageObject(req, res, msg) {
    const result = {
        id: compressID(msg.id),
    }
    if (msg.author) {
        const author = msg.author.global_name ?? msg.author.username;
        result.author = {
            id: compressID(msg.author.id),
            name: oneLine(req, author, false)
        }
        result.authorLine = oneLine(req, author + " " + getIdTimestamp(res, msg.id), false);
        result.timestamp = getIdTimestamp(res, msg.id);  // separate timestamp for html version
    }
    if (msg.type >= 1 && msg.type <= 11) result.type = msg.type;

    // Parse content 
    result.content = parseMessageContent(msg);

    if (msg.referenced_message) {
        let content = parseMessageContent(msg.referenced_message, true);

        // Replace newlines with spaces (reply is shown as one line)
        content = content.replace(/\r\n|\r|\n/gm, "  ");

        if (content && content.length > 50) {
            content = content.slice(0, 47).trim() + '...';
        }
        result.referenced_message = {
            author: {
                name: oneLine(req, msg.referenced_message.author.global_name ?? msg.referenced_message.author.username, false),
                id: compressID(msg.referenced_message.author.id),
            },
            content
        }
    }
    return result;
}

function parseMessageContent(msg, singleLine = false) {
    const target = msg.mentions?.[0]?.global_name ?? msg.mentions?.[0]?.username;
    switch (msg.type) {
        case 1: return `added ${target} to the group`;
        case 2: return `removed ${target} from the group`;
        case 3: return `started a call`;
        case 4: return `changed the group name`;
        case 5: return `changed the group icon`;
        case 6: return `pinned a message`;
        case 7: return `joined the server`;
        case 8: return `boosted the server`;
        case 9: return `boosted the server to level 1`;
        case 10: return `boosted the server to level 2`;
        case 11: return `boosted the server to level 3`;
        default: return parseMessageContentNonStatus(msg, singleLine);
    }
}

function parseMessageContentNonStatus(msg, singleLine) {
    let result = "";

    // Content from forwarded message
    if (msg.message_snapshots) {
        result = parseMessageContent(msg.message_snapshots[0].message);
    }
    // Normal message content
    else if (msg.content) {
        result = parseMessageContentText(msg.content);
    }
    
    if (msg.attachments?.length) {
        msg.attachments.forEach(att => {
            if (result.length) result += "\n";
            result += `(file: ${parseMessageContentText(att.filename)})`;
        })
    }
    if (msg.sticker_items?.length) {
        if (result.length) result += "\n";
        result += `(sticker: ${parseMessageContentText(msg.sticker_items[0].name)})`;
    }
    if (msg.embeds?.length) {
        msg.embeds.forEach(emb => {
            if (!emb.title) return;
            if (result.length) result += "\n";
            result += `(embed: ${parseMessageContentText(emb.title)})`;
        })
    }
    if (result == '') return "(unsupported message)";

    // iOS keyboard (I think it's that) is stupid and replaces apostrophes with this unicode character
    // that shows up as a rectangle/missing character on old phones. Replace it with a normal apostrophe.
    result = result.replace(/’/g, "'");

    result = sanitize(result).replace(/\n/g, singleLine ? ' ' : '<br/>');
    return result;
}

function parseMessageContentText(content) {
    if (!content) return content;
    let result = content
        // try to convert <@12345...> format into @username
        .replace(/<@(\d{15,})>/gm, (mention, id) => {
            if (userCache.has(id)) return `@${userCache.get(id)}`;
            else return mention;
        })
        // try to convert <#12345...> format into #channelname
        .replace(/<#(\d{15,})>/gm, (mention, id) => {
            if (channelNameCache.has(id)) return `#${channelNameCache.get(id)}`;
            else return mention;
        })
        // replace <:name:12345...> emoji format with :name:
        .replace(/<a?(:\w*:)\d{15,}>/gm, "$1")

    // Replace Unicode emojis with :name: textual representations
    emoji.colons_mode = true;
    result = emoji.replace_unified(result);

    // Replace regional indicator emojis with textual representations
    result = result.replace(/\ud83c[\udde6-\uddff]/g, match => {
        return ":regional_indicator_"
            + String.fromCharCode(match.charCodeAt(1) - 0xdde6 + 97)
            + ":";
    })

    return result;
}

function getToken(req, res, next) {
    try {
        res.locals.token = req.query?.token ?? req.body?.token ?? req.cookies?.dwtoken;
        if (!res.locals.token) throw new Error("Your request does not contain a token. Please return to the Discord WAP front page and try again.");

        res.locals.userID = res.locals.token.split('.')[0];

        if (req.query.s0) {
            res.locals.token = res.locals.token.split('.').slice(0, 3).join('.')
                + '.' + req.query.s0
                + '.' + req.query.s1
                + '.' + req.query.s2
                + '.' + req.query.s3
                + '.' + req.query.s4
                + '.' + req.query.s5
                + '.' + req.query.s6;
        }
        const settingsArr = res.locals.token.split('.').slice(3);

        let messageLoadCount = Number(settingsArr[0]) || 10;
        if (messageLoadCount > 100) messageLoadCount = 100;
        else if (messageLoadCount < 1) messageLoadCount = 1;

        let timeOffsetHours = Number(settingsArr[2]) || 0;
        let timeOffsetMinutes = Number(settingsArr[3]) || 0;
        if (timeOffsetHours < -14) timeOffsetHours = -14;
        if (timeOffsetHours > 14) timeOffsetHours = 14;
        if (![0, 15, 30, 45].includes(timeOffsetMinutes)) timeOffsetMinutes = 0;

        res.locals.settings = {
            messageLoadCount,
            altChannelListLayout: (Number(settingsArr[1]) || 0) != 0,
            timeOffsetHours,
            timeOffsetMinutes,
            use12hTime: (Number(settingsArr[4]) || 0) != 0,
            limitTextBoxSize: (Number(settingsArr[5]) || 0) != 0,
            reverseChat: (Number(settingsArr[6]) || 0) != 0,
        }
    
        res.locals.headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Authorization": decompressToken(res.locals.token).split('.').slice(0, 3).join('.'),
            "X-Discord-Locale": "en-GB",
            "X-Debug-Options": "bugReporterEnabled",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin"
        };
        if (req.cookies?.dwtoken != res.locals.token) res.cookie('dwtoken', res.locals.token);
        next();
    }
    catch (e) {
        handleError(res, e);
    }
}

async function fetchDMs(req, res) {
    const dmsGet = await axios.get(
        `${DEST_BASE}/users/@me/channels`,
        {headers: res.locals.headers}
    )
    // Sort by latest first
    dmsGet.data.sort((a, b) => {
        const a_id = BigInt(a.last_message_id ?? 0);
        const b_id = BigInt(b.last_message_id ?? 0);
        return (a_id < b_id ? 1 : a_id > b_id ? -1 : 0)
    });

    return dmsGet.data
        .filter(ch => ch.type == 1 || ch.type == 3)
        .slice(0, (res.locals.format == 'wml') ? 15 : 20)
        .map(ch => {
            const result = {
                id: compressID(ch.id),
                // type: ch.type,
                // last_message_id: ch.last_message_id
            }

            // Add group name for group DMs, recipient name for normal DMs
            if (ch.type == 3) {
                result.name = ch.name;
                result.namePrefix = '';
            } else {
                result.name = ch.recipients[0].global_name ?? ch.recipients[0].username;
                result.namePrefix = '@';
            }
            result.name = oneLine(req, result.name);
            return result;
        })
}

app.use(cookieParser());

app.use((req, res, next) => {
    res.locals.format = req.headers['accept'].includes('html') ? "html" : "wml";
    next();
})

function render(res, viewName, viewVars) {
    if (res.locals.format == "wml") res.set("Content-Type", "text/vnd.wap.wml");
    res.render(`${res.locals.format}/${viewName}`, viewVars);
}

app.get("/wap", (req, res) => {
    render(res, "index", {
        userAgent: req.headers['user-agent']
    });
})

app.get("/wap/about", (req, res) => {
    render(res, "about", {
        userAgent: req.headers['user-agent']
    });
})

// Main menu (including DMs in WML version)
app.get("/wap/main", getToken, async (req, res) => {
    try {
        const dms = (res.locals.format == 'wml') && await fetchDMs(req, res);

        render(res, "main", {
            token: compressToken(res.locals.token),
            dms,
        });
    }
    catch (e) {handleError(res, e)}
})

// Direct message list (separate page for HTML version)
app.get("/wap/dm", getToken, async (req, res) => {
    try {
        const dms = await fetchDMs(req, res);

        render(res, "dms", {
            token: compressToken(res.locals.token),
            reverseChat: res.locals.settings.reverseChat,
            dms,
        });
    }
    catch (e) {handleError(res, e)}
})

const guildCache = new LRUCache({max: 200, ttl: 10*60*1000, updateAgeOnGet: false})

// Server list
app.get("/wap/gl", getToken, async (req, res) => {
    try {
        let guilds;

        if (guildCache.has(res.locals.userID)) {
            guilds = guildCache.get(res.locals.userID);
        } else {
            const guildsGet = await axios.get(
                `${DEST_BASE}/users/@me/guilds`,
                {headers: res.locals.headers}
            )
            guilds = guildsGet.data.map(g => ({
                id: compressID(g.id),
                name: oneLine(req, g.name)
            }))
            guildCache.set(res.locals.userID, guilds);
        }

        render(res, "guilds", {
            guilds
        });
    }
    catch (e) {handleError(res, e)}
})

const channelCache = new LRUCache({max: 400, ttl: 10*60*1000, updateAgeOnGet: false});

// Channel list of a server
app.get("/wap/g", getToken, async (req, res) => {
    try {
        // Channel list cache can be used if last message IDs are not relevant ("Recent channels first" disabled and using HTML version)
        const useCache = (!res.locals.settings.altChannelListLayout && res.locals.format == 'html')
        let channelsGet;

        if (useCache && channelCache.has(req.query.id)) {
            channelsGet = channelCache.get(req.query.id);
        } else {
            channelsGet = await axios.get(
                `${DEST_BASE}/guilds/${decompressID(req.query.id)}/channels`,
                {headers: res.locals.headers}
            )
            if (useCache) channelCache.set(req.query.id, channelsGet);
        }

        // Populate channel name cache
        channelsGet.data.forEach(ch => {
            channelNameCache.set(ch.id, ch.name);
        })

        // Due to page length limitations, limit the amount of channels to be shown:

        // Sort channels by most recently used
        const allChannels = channelsGet.data.filter(ch => ch.type == 0 || ch.type == 5);
        allChannels.sort((a, b) => {
            const a_id = BigInt(a.last_message_id ?? 0);
            const b_id = BigInt(b.last_message_id ?? 0);
            return (a_id < b_id ? 1 : a_id > b_id ? -1 : 0)
        });

        let channels;

        if (res.locals.settings.altChannelListLayout) {
            // "Recent channels first" option enabled: show up to 15 (WML) or 30 (HTML) channels in order of most recent message
            channels = allChannels
                .slice(0, (res.locals.format == 'wml') ? 15 : 30)
                .map(ch => ({
                    id: compressID(ch.id),
                    name: oneLine(req, '#' + ch.name),
                    label: oneLine(req, getIdTimestamp(res, ch.last_message_id) + ' ' + ch.name)
                }))
        } else {
            // "Recent channels first" disabled: show channels in their original order (still only show 15 most recently used channels in WML)
            if (res.locals.format == 'wml') {
                const recentChannelIDs = allChannels
                    .slice(0, 15)
                    .map(ch => ch.id);
        
                // Also, channels with certain names will always be shown, because those are channels that people might often want to visit.
                const whitelistedChannelIDs = allChannels
                    .filter(ch => /^(general|phones|off\S*topic|discord-j2me-wap)$/g.test(ch.name))
                    .map(ch => ch.id);
        
                const shownChannelIDs = [...new Set([...recentChannelIDs, ...whitelistedChannelIDs])]
        
                channels = allChannels.filter(ch => shownChannelIDs.includes(ch.id));
            } else {
                channels = allChannels;
            }

            channels = channels
                .sort((a, b) => a.position - b.position)
                .map(ch => ({
                    id: compressID(ch.id),
                    name: oneLine(req, '#' + ch.name),
                    label: oneLine(req, '#' + ch.name)
                }))
        }

        render(res, "channels", {
            gname: req.query.gname,
            reverseChat: res.locals.settings.reverseChat,
            channels
        });
    }
    catch (e) {handleError(res, e)}
})

// Get channel messages
app.get("/wap/ch", getToken, async (req, res) => {
    try {
        let proxyUrl = `${DEST_BASE}/channels/${decompressID(req.query.id)}/messages`;
        let queryParam = [`limit=${res.locals.settings.messageLoadCount}`];
        if (req.query.before) queryParam.push(`before=${decompressID(req.query.before)}`);
        if (req.query.after) queryParam.push(`after=${decompressID(req.query.after)}`);
        proxyUrl += '?' + queryParam.join('&');
    
        const messagesGet = await axios.get(proxyUrl, {headers: res.locals.headers});
    
        // Populate username cache
        messagesGet.data.forEach(msg => {
            userCache.set(msg.author.id, msg.author.username);
        })
    
        const messages = messagesGet.data.map(m => parseMessageObject(req, res, m));

        if (res.locals.settings.reverseChat && res.locals.format == 'html') {
            messages.reverse();
        }
    
        render(res, "channel", {
            id: req.query.id,
            page: req.query.page ?? 0,
            messages,
            messageCount: res.locals.settings.messageLoadCount,
            reverseChat: res.locals.settings.reverseChat,
            textBoxSize: res.locals.settings.limitTextBoxSize ? 200 : 2000,
            id: req.query.id,
            cname: req.query.cname,
        });
    }
    catch (e) {handleError(res, e)}
})

app.get("/wap/send", getToken, async (req, res) => {
    render(res, "send", {
        id: req.query.id,
        cname: req.query.cname,
        token: req.query.token,
    })
})

app.get("/wap/reply", getToken, async (req, res) => {
    render(res, "reply", {
        id: req.query.id,
        cname: req.query.cname,
        token: req.query.token,
        rec: req.query.rec,
        recname: req.query.recname,
    })
})

// Send message
app.post("/wap/send", getToken, async (req, res) => {
    try {
        const send = {
            content: req.body.text,
            flags: 0,
            mobile_network_type: "unknown",
            tts: false
        };
        if (req.body.recipient) {
            send.message_reference = {
                message_id: String(decompressID(req.body.recipient))
            }
        }
        if (Number(req.body.ping) == 0) {
            send.allowed_mentions = {
                replied_user: false
            }
        }

        await axios.post(
            `${DEST_BASE}/channels/${decompressID(req.body.id)}/messages`,
            send,
            {headers: res.locals.headers}
        );

        render(res, "sent", {
            cname: req.query.cname
        });
    }
    catch (e) {handleError(res, e)}
})

app.get("/wap/set", getToken, (req, res) => {
    render(res, "settings", {
        settings: res.locals.settings,
        token: req.query.token
    });
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
