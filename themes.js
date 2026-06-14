const themes = [
    {
        id: "standard",
        name: "Standard",
        viewsDir: "standard",
        replyPreviewLength: 50,
        showAttachments: true,
        messageCountDefault: 15,
        messagesOnBottomDefault: true,
        basic: false,
        oneLineTruncate: false,
        guildsPageSize: 30,
    },
    {
        id: "basic",
        name: "Basic",
        viewsDir: "standard",
        replyPreviewLength: 25,
        showAttachments: false,
        messageCountDefault: 10,
        messagesOnBottomDefault: false,
        basic: true,
        oneLineTruncate: true,
        guildsPageSize: 20,
    },
    {
        id: "touch",
        name: "Touch",
        viewsDir: "touch",
        replyPreviewLength: 50,
        showAttachments: true,
        messageCountDefault: 20,
        messagesOnBottomDefault: true,
        oneLineTruncate: false,
        guildsPageSize: 999,
    },
    {
        id: "touch_dark",
        name: "Touch Dark",
        viewsDir: "touch",
        replyPreviewLength: 50,
        showAttachments: true,
        messageCountDefault: 20,
        messagesOnBottomDefault: true,
        oneLineTruncate: false,
        guildsPageSize: 999,
    },
    // {
    //     id: "wml",
    //     name: "WML",
    //     viewsDir: "wml",
    //     replyPreviewLength: 20,
    //     showAttachments: false,
    //     messageCountDefault: 10,
    //     messagesOnBottomDefault: false,
    //     oneLineTruncate: false,
    // }
]

function getDefaultThemeName(req, res) {
    if (res.locals.format == 'wml') return 'wml';

    const ua = (req.headers['user-agent'] ?? '').toLowerCase();
    if (/android|iphone|ipod|maemo|meego/g.test(ua)) return 'touch';

    if (ua.startsWith('sonyericsson') && !/midp-2/.test(ua)) return 'basic';

    return 'standard';
}

function getDefaultTheme(req, res) {
    return themes.find(th => th.id == getDefaultThemeName(req, res)) ?? themes[0];
}

module.exports = {
    themes,
    getDefaultTheme
};