function decompressID(id, type) {
    try {
        const idStr = Array.from(Buffer.from(id, 'base64url'));

        return String(
            BigInt(idStr[0]) << 56n |
            BigInt(idStr[1]) << 48n |
            BigInt(idStr[2]) << 40n |
            BigInt(idStr[3]) << 32n |
            BigInt(idStr[4]) << 24n |
            BigInt(idStr[5]) << 16n |
            BigInt(idStr[6]) << 8n |
            BigInt(idStr[7])
        );
    } catch (e) {
        throw new Error(`A required ${type} ID is missing or invalid. Please return to the Discord WAP front page and try again.`);
    }
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
    return Buffer.from(arr).toString('base64url');
}

function decompressToken(token) {
    if (!token || !token.trim().length) throw new Error("Token not specified");

    try {
        let idPart = token.split('.')[0];
        const rest = '.' + token.split('.').slice(1).join('.');
    
        if (idPart.length < 17) {
            idPart = btoa(decompressID(idPart, 'user'));
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

module.exports = {
    decompressID,
    compressID,
    decompressToken,
    compressToken
}