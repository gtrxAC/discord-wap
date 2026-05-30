const themes = [
    {
        id: "standard",
        name: "Standard",
        viewsDir: "standard",
        replyPreviewLength: 50,
        showAttachments: true,
    },
    {
        id: "touch",
        name: "Touch",
        viewsDir: "touch",
        replyPreviewLength: 50,
        showAttachments: true,
    },
    {
        id: "wml",
        name: "WML",
        viewsDir: "wml",
        replyPreviewLength: 20,
        showAttachments: false,
    }
]

function getDefaultThemeName(req, res) {
    if (res.locals.format == 'wml') return 'wml';

    const ua = (req.headers['user-agent'] ?? '').toLowerCase();
    if (/android|iphone|ipod|maemo|meego/g.test(ua)) return 'touch';

    return 'standard';
}

function getDefaultTheme(req, res) {
    return themes.find(th => th.id == getDefaultThemeName(req, res)) ?? themes[0];
}

module.exports = {
    themes,
    getDefaultTheme
};