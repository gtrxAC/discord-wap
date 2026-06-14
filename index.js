require('dotenv').config();
const express = require('express');
const axios = require('axios');
const EmojiConvertor = require('emoji-js');
const path = require('path');
const { LRUCache } = require('lru-cache');
const cookieParser = require('cookie-parser');
const { minify } = require('html-minifier-terser');
const ejs = require('ejs');

const { testGateway, getNotifications } = require('./gateway');
const { themes, getDefaultTheme } = require('./themes');
const { compressID, decompressID, compressToken, decompressToken } = require('./compress');
const stringFormatMiddleware = require('./format');

const emoji = new EmojiConvertor();
emoji.replace_mode = 'unified';

const app = express();
const DEST_BASE = "https://discord.com/api/v9";

app.set('view engine', 'ejs');
app.set('views', './views');

app.use(express.static(path.join(__dirname, 'static')));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(stringFormatMiddleware);

// ID -> username mapping cache (used for parsing mentions)
const userCache = new LRUCache({max: 10000});
const channelNameCache = new LRUCache({max: 10000});

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

function normalizeStr(str, convertEmoji = false) {
    if (str === null || str === undefined) return "(err)";
    str = String(str);
    if (convertEmoji) str = parseMessageContentText(str);
    return str;
}

function normalizeStrRemoveEmoji(str) {
    str = normalizeStr(str);
    const strConvEmoji = normalizeStr(str, true);
    if (str == strConvEmoji) return str;

    const strNoEmoji = strConvEmoji.replace(/:\w+:/g, '');
    if (strNoEmoji.length) return strNoEmoji;
    return strConvEmoji;
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

function parseMessageObject(req, res, msg) {
    const result = {
        id: compressID(msg.id),
        showAuthor: msg.showAuthor,
        avatar: msg.avatar,
        edited: msg.edited_timestamp
    }
    if (msg.author) {
        const author = msg.author.global_name ?? msg.author.username;
        result.author = {
            id: compressID(msg.author.id),
            name: normalizeStrRemoveEmoji(author),
        }
        result.authorLine = normalizeStrRemoveEmoji(author + " " + getIdTimestamp(res, msg.id));
        result.timestamp = getIdTimestamp(res, msg.id);  // separate timestamp for html version
    }
    if (msg.type >= 1 && msg.type <= 11) {
        result.isStatus = true;
        result.type = msg.type;
    }

    // Parse content 
    result.content = parseMessageContent(res, msg);

    if (msg.referenced_message) {
        let content = parseMessageContent(res, msg.referenced_message, true);

        // Replace newlines with spaces (reply is shown as one line)
        content = content.replace(/\r\n|\r|\n/gm, "  ");

        const limit = res.locals.theme.replyPreviewLength;

        if (content && content.length > limit) {
            content = content.slice(0, limit - 3).trim() + '...';
        }
        result.referenced_message = {
            author: {
                name: normalizeStrRemoveEmoji(msg.referenced_message.author.global_name ?? msg.referenced_message.author.username),
                id: compressID(msg.referenced_message.author.id),
            },
            content
        }
    }

    if (res.locals.theme.showAttachments && msg.attachments) {
        result.attachments = msg.attachments.map(att => {
            const isImage = att.content_type?.includes('image');
            let url;
            if (isImage) {
                let width = att.width;
                let height = att.height;
                if (width > 1000 || height > 1000) {
                    const ratio = Math.max(att.width, att.height)/1000;
                    width = Math.round(width/ratio);
                    height = Math.round(height/ratio);
                }
                url = att.proxy_url.replace(/^https/, 'http') + `width=${width}&height=${height}`;
            }
            else if (process.env.CDN_PROXY) {
                url = att.url.replace("https://cdn.discordapp.com", process.env.CDN_PROXY);
            }
            else {
                url = att.url;
            }

            return {
                filename: att.filename,
                url
            }
        })
    }

    return result;
}

function parseMessageContent(res, msg, singleLine = false) {
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
        default: return parseMessageContentNonStatus(res, msg, singleLine);
    }
}

function parseMessageContentNonStatus(res, msg, singleLine) {
    let result = "";

    // Content from forwarded message
    if (msg.message_snapshots) {
        result = parseMessageContent(res, msg.message_snapshots[0].message);
    }
    // Normal message content
    else if (msg.content) {
        result = parseMessageContentText(msg.content);
    }
    
    if (msg.attachments?.length && !res.locals.theme.showAttachments) {
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
    if (result == '' && !msg.attachments) return "(unsupported message)";

    // iOS keyboard (I think it's that) is stupid and replaces apostrophes with this unicode character
    // that shows up as a rectangle/missing character on old phones. Replace it with a normal apostrophe.
    result = result.replace(/’/g, "'");

    if (singleLine) result = result.replace(/\n/g, " ");
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
            if (channelNameCache.has(id)) return channelNameCache.get(id);
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

function makeGetTokenMiddleware(isOptional) {
    return (req, res, next) => {
        res.locals.token = req.query?.t ?? req.query?.token ?? req.body?.t ?? req.body?.token ?? req.cookies?.dwtoken;

        if (!res.locals.token) {
            if (isOptional) {
                res.locals.token = "";
                res.locals.compressedToken = "";
                res.locals.tokenParam = "";
                next();
                return;
            } else {
                throw new Error("Your request does not contain a token. Please return to the Discord WAP front page and try again.");
            }
        }
        
        if (process.env.PASSWORD && process.env.PASSWORD_TOKEN && res.locals.token == process.env.PASSWORD) {
            res.locals.token = process.env.PASSWORD_TOKEN;
        }

        res.locals.userID = res.locals.token.split('.')[0];

        if (req.query.s0) {
            res.locals.token = res.locals.token.split('.').slice(0, 3).join('.')
                + '.' + req.query.s0
                + '.' + req.query.s1
                + '.' + req.query.s2
                + '.' + req.query.s3
                + '.' + req.query.s4
                + '.' + req.query.s5
                + '.' + req.query.s6
                + '.' + req.query.s7;
        }
        const settingsArr = res.locals.token.split('.').slice(3);

        const themeIndex = Number(settingsArr[7]);
        
        if (themeIndex >= 0 && themeIndex < themes.length) {
            res.locals.theme = themes[themeIndex];
        }

        res.locals.format = (res.locals.theme.id == 'wml') ? 'wml' : 'html';

        let messageLoadCount = Number(settingsArr[0]) || res.locals.theme.messageCountDefault;
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
            reverseChat: (Number(settingsArr[6] ?? res.locals.theme.messagesOnBottomDefault)) != 0,
        }

        res.locals.authToken = decompressToken(res.locals.token).split('.').slice(0, 3).join('.');

        res.locals.headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Authorization": res.locals.authToken,
            "X-Discord-Locale": "en-GB",
            "X-Debug-Options": "bugReporterEnabled",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin"
        };
        if (req.cookies?.dwtoken != res.locals.token) {
            res.cookie('dwtoken', res.locals.token, {maxAge: 1000*60*60*24*30});
        }
        res.locals.compressedToken = compressToken(res.locals.token);
        res.locals.tokenParam = '?t=' + res.locals.compressedToken;
        next();
    }
}

const getToken = makeGetTokenMiddleware(false);
const getTokenOptional = makeGetTokenMiddleware(true);

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
            let cacheName;
            result.isGroup = (ch.type == 3);
            if (result.isGroup) {
                result.name = ch.name ?? ch.recipients.map(rec => rec.global_name ?? rec.username).join(", ");
                cacheName = result.name;
            } else {
                result.name = ch.recipients[0].global_name ?? ch.recipients[0].username;
                cacheName = '@' + result.name;
            }

            // populate cache
            channelNameCache.set(ch.id, cacheName);

            result.name = normalizeStrRemoveEmoji(result.name, true);
            return result;
        })
}


app.use((req, res, next) => {
    res.locals.format = req.accepts("html") ? "html" : "wml";
    res.locals.theme = getDefaultTheme(req, res);
    next();
})

async function render(res, viewName, viewVars) {
    if (res.locals.format == "wml") res.set("Content-Type", "text/vnd.wap.wml");

    const rendered = await ejs.renderFile(`views/${res.locals.theme.viewsDir}/${viewName}.ejs`, {
        ...res.locals,
        settings: res.locals.settings,
        ...viewVars
    })

    const minified = await minify(rendered, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true
    });

    res.send(minified);
}

app.get("/", (req, res) => {
    render(res, "index", {
        userAgent: req.headers['user-agent']
    });
});

app.get("/about", getTokenOptional, (req, res) => {
    render(res, "about", {
        userAgent: req.headers['user-agent']
    });
})

// Main menu (including DMs in WML version)
app.get("/main", getToken, async (req, res) => {
    render(res, "main", {
        dms: (res.locals.format == 'wml') && await fetchDMs(req, res),
    });
})

// Direct message list (separate page for HTML version)
app.get("/d", getToken, async (req, res) => {
    res.locals.dms = await fetchDMs(req, res);
    render(res, "dms");
})

// Inbox (mentions and received DMs)
app.get("/i", getToken, async (req, res) => {
    const notifications = await getNotifications(res.locals.authToken);

    notifications.sort((a, b) => {
        // DMs first
        if (!a.guildName && b.guildName) return -1;
        if (!b.guildName && a.guildName) return 1;

        // otherwise sort by channel name alphabetically
        if (a.channelName < b.channelName) return -1;
        if (b.channelName < a.channelName) return 1;
        return 0;
    });

    render(res, "inbox", {
        notifications,
        compressID
    });
})

const guildCache = new LRUCache({max: 500, ttl: 60*60*1000, updateAgeOnGet: false})

async function getGuilds(req, res) {
    if (guildCache.has(res.locals.userID)) {
        return guildCache.get(res.locals.userID);
    } else {
        const guildsGet = await axios.get(
            `${DEST_BASE}/users/@me/guilds`,
            {headers: res.locals.headers}
        )
        // Get user settings which contains the order of servers
        const userSettingsGet = await axios.get(
            `${DEST_BASE}/users/@me/settings`,
            {headers: res.locals.headers}
        )

        const folders = userSettingsGet.data.guild_folders;
        const unsortedGuildsGet = [...guildsGet.data];
        const sortedGuildsGet = [];

        folders.forEach(f => {
            f.guild_ids.forEach(gid => {
                sortedGuildsGet.push(guildsGet.data.find(g => g.id == gid));
                unsortedGuildsGet.filter(g => g.id != gid);
            })
        })
        sortedGuildsGet.concat(...unsortedGuildsGet);

        const guilds = sortedGuildsGet.map(g => ({
            id: compressID(g.id),
            name: normalizeStrRemoveEmoji(g.name, true),
        }))
        guildCache.set(res.locals.userID, guilds);
        return guilds;
    }
}

async function getGuildName(req, res, guildID) {
    if (!guildID) return null;
    const guilds = await getGuilds(req, res);
    const guild = guilds.find(g => g.id == guildID);
    if (!guild) return "(unknown)";
    return guild.name;
}

// get prefix for routes that can be used with both guilds and DMs
function getGuildPath(guildID) {
    if (guildID) return `/g/${guildID}/c`;
    return '/d';  // no guild -> is DM
}

// Server list
app.get("/g", getToken, async (req, res) => {
    const guilds = await getGuilds(req, res);

    const pageSize = res.locals.theme.guildsPageSize;
    const pageBegin = Number(req.query.p ?? 0);
    const pageEnd = pageBegin + pageSize;

    res.locals.hasMoreAbove = (pageBegin != 0);
    res.locals.hasMoreBelow = (guilds.length > pageEnd);
    res.locals.nextPage = pageEnd;
    res.locals.previousPage = Math.max(0, pageBegin - pageSize);
    res.locals.guilds = guilds.slice(pageBegin, pageEnd);

    render(res, "guilds");
})

const channelCache = new LRUCache({max: 400, ttl: 10*60*1000, updateAgeOnGet: false});

async function getChannels(req, res, guildID, useCache) {
    if (!guildID) guildID = res.locals.userID;

    if (useCache && channelCache.has(guildID)) {
        return channelCache.get(guildID);
    } else {
        const channels = await axios.get(
            `${DEST_BASE}/guilds/${decompressID(guildID, 'server')}/channels`,
            {headers: res.locals.headers}
        )
        if (useCache) channelCache.set(guildID, channels.data);

        // Populate channel name cache
        channels.data.forEach(ch => {
            channelNameCache.set(ch.id, '#' + ch.name);
        })
        return channels.data;
    }
}

async function getChannelName(req, res, guildID, channelID) {
    const decompressedID = decompressID(channelID, "channel");

    let cachedName = channelNameCache.get(decompressedID);
    if (cachedName) return cachedName;

    if (guildID) {
        const channels = await getChannels(req, res, guildID, true);
        const channel = channels.find(c => c.id == decompressedID);
        if (!channel) return "(unknown)";
        return '#' + channel.name;
    } else {
        const dmChannels = await fetchDMs(req, res);
        cachedName = channelNameCache.get(decompressedID);
        if (!cachedName) return "(unknown)";
        return cachedName;
    }
}

// Channel list of a server
app.get(["/g/:guildid", "/g/:guildid/c"], getToken, async (req, res) => {
    const guildID = req.params.guildid;
    const guildName = await getGuildName(req, res, guildID);

    // Channel list cache can be used if last message IDs are not relevant ("Recent channels first" disabled and using HTML version)
    const useCache = (!res.locals.settings.altChannelListLayout && res.locals.format == 'html');

    const channelsGet = await getChannels(req, res, guildID, useCache);

    // Due to page length limitations, limit the amount of channels to be shown:

    // Sort channels by most recently used
    const allChannels = channelsGet.filter(ch => ch.type == 0 || ch.type == 5);
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
                name: normalizeStrRemoveEmoji(ch.name),
                label: normalizeStrRemoveEmoji(getIdTimestamp(res, ch.last_message_id) + ' ' + ch.name),
                timestamp: getIdTimestamp(res, ch.last_message_id),
                parent_id: ch.parent_id
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
                name: normalizeStrRemoveEmoji(ch.name),
                label: normalizeStrRemoveEmoji('#' + ch.name),
                parent_id: ch.parent_id
            }))
    }

    const allChannelCategories = channelsGet.filter(ch => ch.type == 4)
        .sort((a, b) => a.position - b.position)
        .map(ch => ({
            ...ch,
            name: normalizeStrRemoveEmoji(ch.name),
            children: []
        }));

    // default category for channels that are not in any category (shown at the top both on official clients and on wap)
    const defaultCategory = {
        name: guildName,
        children: []
    };
    allChannelCategories.unshift(defaultCategory);

    channels.forEach(ch => {
        const cat = allChannelCategories.find(cat => cat.id == ch.parent_id);
        if (cat) {
            cat.children.push(ch);
        } else {
            defaultCategory.children.push(ch);
        }
    })

    const channelCategories = allChannelCategories.filter(ch => ch.children.length);

    render(res, "channels", {
        gname: guildName,
        gid: guildID,
        channels,
        channelCategories
    });
})

// ported from discord j2me
function shouldShowAuthor(msg, above, clusterStart) {
    if (!above) return true;
    if (msg.referenced_message) return true;
    if (above.author?.id != msg.author?.id) return true;
    if (msg.attachments && !msg.content) return true;
    if (msg.isStatus || above.isStatus) return true;

    return (BigInt(msg.id) >> 22n) - (BigInt(clusterStart) >> 22n) > BigInt(7*60*1000);
}

// Get channel messages
app.get(["/d/:channelid", "/g/:guildid/c/:channelid"], getToken, async (req, res) => {
    const guildID = req.params.guildid;
    const channelID = req.params.channelid;
    const guildName = await getGuildName(req, res, guildID);
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    let proxyUrl = `${DEST_BASE}/channels/${decompressID(channelID, 'channel')}/messages`;
    let queryParam = [`limit=${res.locals.settings.messageLoadCount}`];
    if (req.query.b) queryParam.push(`before=${decompressID(req.query.b, 'message')}`);
    if (req.query.a) queryParam.push(`after=${decompressID(req.query.a, 'message')}`);
    proxyUrl += '?' + queryParam.join('&');

    const messagesGet = (await axios.get(proxyUrl, {headers: res.locals.headers})).data;

    // Populate username cache
    messagesGet.forEach(msg => {
        userCache.set(msg.author.id, msg.author.username);
    })

    // Message ID that should be marked as read
    // (don't mark as read if reading an older page of messages)
    const markReadID = !req.query.p && messagesGet.length && messagesGet[0].id;

    // See which messages the author line and profile pic should be shown for
    if (res.locals.settings.reverseChat && res.locals.format == 'html') {
        messagesGet.reverse();
    }
    let clusterStart = 0;
    let above = null;

    messagesGet.forEach(m => {
        m.showAuthor = shouldShowAuthor(m, above, clusterStart);
        if (m.showAuthor) {
            clusterStart = m.id;

            if (m.author?.id && m.author?.avatar) {
                m.avatar = `http://media.discordapp.net/avatars/${m.author.id}/${m.author.avatar}.png?size=16`
            }
        }
        above = m;
    })

    const messages = messagesGet.map(m => parseMessageObject(req, res, m));

    render(res, "channel", {
        page: req.query.p ?? 0,
        messages,
        textBoxSize: res.locals.settings.limitTextBoxSize ? 200 : 2000,
        id: channelID,
        cname: channelName,
        gid: guildID,
        gname: guildName,
        gpath: guildPath,
    });

    // Mark latest message as read
    if (markReadID) {
        axios.post(
            `${DEST_BASE}/channels/${decompressID(channelID, 'channel')}/messages/${markReadID}/ack`,
            {token: null},
            {headers: res.locals.headers}
        )
        .catch(e => {
            console.log(e);
        })
    }
})

app.get(["/d/:channelid/send", "/g/:guildid/c/:channelid/send"], getToken, async (req, res) => {
    const guildID = req.params.guildid;
    const channelID = req.params.channelid;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    render(res, "send", {
        id: channelID,
        cname: channelName,
        gid: guildID,
        gpath: guildPath
    })
})

app.get(["/d/:channelid/reply/:messageid", "/g/:guildid/c/:channelid/reply/:messageid"], getToken, async (req, res) => {
    const guildID = req.params.guildid;
    const channelID = req.params.channelid;
    const messageID = req.params.messageid;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    render(res, "reply", {
        id: channelID,
        cname: channelName,
        rec: messageID,
        gpath: guildPath,
        recname: req.query.recname,
    })
})

// Send message
app.post(["/d/:channelid/send", "/g/:guildid/c/:channelid/send"], getToken, async (req, res) => {
    const guildID = req.params.guildid;
    const channelID = req.params.channelid;
    const guildPath = getGuildPath(guildID);

    const send = {
        content: req.body.text,
        flags: 0,
        mobile_network_type: "unknown",
        tts: false
    };
    if (req.body.recipient) {
        send.message_reference = {
            message_id: String(decompressID(req.body.recipient, 'message'))
        }
    }
    if (Number(req.body.ping) == 0) {
        send.allowed_mentions = {
            replied_user: false
        }
    }

    await axios.post(
        `${DEST_BASE}/channels/${decompressID(channelID, 'channel')}/messages`,
        send,
        {headers: res.locals.headers}
    );

    res.redirect(`${guildPath}/${channelID}`);
})

app.get("/set", getToken, (req, res) => {
    render(res, "settings", {
        token: req.query.token,
        themes,
        timePreview: getIdTimestamp(res, ((BigInt(Date.now()) - 1420070400000n) << 22n).toString())
    });
})

// Error handler
app.use((err, req, res, next) => {
    console.log(err);
    render(res, "error", {error: getError(err)});
})

app.listen(process.env.PORT, () => {
    console.log(`Server is running on http://localhost:${process.env.PORT}`);
});

testGateway();