const express = require('express');
const axios = require('axios');
const EmojiConvertor = require('emoji-js');

const emoji = new EmojiConvertor();
emoji.replace_mode = 'unified';

const app = express();
const PORT = 8008;
const DEST_BASE = "https://discord.com/api/v9";

app.set('view engine', 'ejs');
app.set('views', './views');

app.use(express.urlencoded({ extended: true }));

// ID -> username mapping cache (used for parsing mentions)
const userCache = new Map();
const channelCache = new Map();
const CACHE_SIZE = 10000;

// Base64 but better - instead of '/' and '=' characters, we use '-' and '_', which stay as one character when URL encoded
function customBase64Decode(str) {
    return atob(str.replace(/-/g, '/').replace(/_/g, '='));
}
function customBase64Encode(str) {
    return btoa(str).replace(/\//g, '-').replace(/=/g, '_')
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

    // could check some non-nokia models, for now, make a safe assumption of 16 chars
    // could also use uaprof on devices that have that
    if (!ua || !ua.startsWith('Nokia')) return 16;

    // models with 84×48 display
    if (/^Nokia(3330|5510|8265|8310)/.test(ua)) return 17;

    // models with 96×65 or similar display (list may be incomplete)
    if (/^Nokia(1101|3350|3410|35[^0]\d|3610|6010|6210|6310|6510|7110|8910)/.test(ua)) return 20;

    // other nokias, assume a 128×128 or 128×160 display
    return 21;
}

function oneLine(req, str) {
    // Make sure string fits on one line on the screen
    if (str === null || str === undefined) return "(err)";
    str = parseMessageContentText(String(str));

    const chars = getCharactersPerLine(req);

    if (str.length > chars) return str.substring(0, chars - 1) + "...";
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
    return e.message;
}

function handleError(res, e) {
    console.log(e);
    res.render("error", {error: getError(e)});
}

function parseMessageObject(req, msg) {
    const result = {
        id: compressID(msg.id)
    }
    if (msg.author) {
        result.author = {
            id: compressID(msg.author.id),
            name: oneLine(req, msg.author.global_name ?? msg.author.username)
        }
    }
    if (msg.type >= 1 && msg.type <= 11) result.type = msg.type;

    // Parse content 
    result.content = parseMessageContent(msg);

    if (msg.referenced_message) {
        let content = parseMessageContent(msg.referenced_message);

        // Replace newlines with spaces (reply is shown as one line)
        content = content.replace(/\r\n|\r|\n/gm, "  ");

        if (content && content.length > 50) {
            content = content.slice(0, 47).trim() + '...';
        }
        result.referenced_message = {
            author: {
                name: oneLine(req, msg.referenced_message.author.global_name ?? msg.referenced_message.author.username),
                id: compressID(msg.referenced_message.author.id),
            },
            content
        }
    }
    return result;
}

function parseMessageContent(msg) {
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
        default: return parseMessageContentNonStatus(msg);
    }
}

function parseMessageContentNonStatus(msg) {
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
    return result.replace(/’/g, "'");
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
            if (channelCache.has(id)) return `#${channelCache.get(id)}`;
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
        res.locals.token = req.query?.token ?? req.body?.token;

        if (req.query.s0) {
            res.locals.token = res.locals.token.split('.').slice(0, 3).join('.')
                + '.' + req.query.s0
                + '.' + req.query.s1
                + '.' + req.query.s2
                + '.' + req.query.s3
                + '.' + req.query.s4;
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
            use12hTime: (Number(settingsArr[4]) || 0) != 0
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
        next();
    }
    catch (e) {
        handleError(res, e);
    }
}

app.use((req, res, next) => {
    res.set("Content-Type", "text/vnd.wap.wml");
    next();
})

app.get("/wap", (req, res) => {
    res.render("index");
})

// Main menu including DMs
app.get("/wap/main", getToken, async (req, res) => {
    try {
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

        const dms = dmsGet.data
            .filter(ch => ch.type == 1 || ch.type == 3)
            .slice(0, 15)
            .map(ch => {
                const result = {
                    id: compressID(ch.id),
                    // type: ch.type,
                    // last_message_id: ch.last_message_id
                }

                // Add group name for group DMs, recipient name for normal DMs
                if (ch.type == 3) {
                    result.name = ch.name;
                } else {
                    result.name = ch.recipients[0].global_name ?? ch.recipients[0].username;
                }
                result.name = oneLine(req, result.name);
                return result;
            })

        res.render("main", {
            token: compressToken(res.locals.token),
            dms
        });
    }
    catch (e) {handleError(res, e)}
})

// Server list
app.get("/wap/gl", getToken, async (req, res) => {
    try {
        const guildsGet = await axios.get(
            `${DEST_BASE}/users/@me/guilds`,
            {headers: res.locals.headers}
        )

        const guilds = guildsGet.data.map(g => ({
            id: compressID(g.id),
            name: oneLine(req, g.name)
        }))

        res.render("guilds", {
            guilds
        });
    }
    catch (e) {handleError(res, e)}
})

// Channel list of a server
app.get("/wap/g", getToken, async (req, res) => {
    try {
        const channelsGet = await axios.get(
            `${DEST_BASE}/guilds/${decompressID(req.query.id)}/channels`,
            {headers: res.locals.headers}
        )

        // Populate channel name cache
        channelsGet.data.forEach(ch => {
            channelCache.set(ch.id, ch.name);

            // If max size exceeded, remove the oldest item
            if (channelCache.size > CACHE_SIZE) {
                channelCache.delete(channelCache.keys().next().value);
            }
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

        // Up to 15 most recently used channels are shown.
        if (res.locals.settings.altChannelListLayout) {
            channels = allChannels
                .slice(0, 15)
                .map(ch => ({
                    id: compressID(ch.id),
                    name: oneLine(req, '#' + ch.name),
                    label: oneLine(req, getIdTimestamp(res, ch.last_message_id) + ' ' + ch.name)
                }))
        } else {
            const recentChannelIDs = allChannels
                .slice(0, 15)
                .map(ch => ch.id);
    
            // Also, channels with certain names will always be shown, because those are channels that people might often want to visit.
            const whitelistedChannelIDs = allChannels
                .filter(ch => /^(general|phones|off\S*topic|discord-j2me)$/g.test(ch.name))
                .map(ch => ch.id);
    
            const shownChannelIDs = [...new Set([...recentChannelIDs, ...whitelistedChannelIDs])]
    
            channels = allChannels
                .filter(ch => shownChannelIDs.includes(ch.id))
                .sort((a, b) => a.position - b.position)
                .map(ch => ({
                    id: compressID(ch.id),
                    name: oneLine(req, '#' + ch.name),
                    label: oneLine(req, '#' + ch.name)
                }))
        }

        res.render("channels", {
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
    
            // If max size exceeded, remove the oldest item
            if (userCache.size > CACHE_SIZE) {
                userCache.delete(userCache.keys().next().value);
            }
        })
    
        const messages = messagesGet.data.map(m => parseMessageObject(req, m));
    
        res.render("channel", {
            id: req.query.id,
            page: req.query.page ?? 0,
            messages,
            messageCount: res.locals.settings.messageLoadCount
        });
    }
    catch (e) {handleError(res, e)}
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

        res.render("sent");
    }
    catch (e) {handleError(res, e)}
})

app.get("/wap/set", getToken, (req, res) => {
    res.render("settings", {
        settings: res.locals.settings
    });
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
