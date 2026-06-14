const { writeFileSync } = require('fs');
const net = require('net');

const GATEWAY_PROXY_IP = process.env.GATEWAY_PROXY_IP ?? "localhost";
const GATEWAY_PROXY_PORT = process.env.GATEWAY_PROXY_PORT ?? 8081;

let supportsGateway = false;

function testGateway() {
    const client = net.Socket();
    client.connect(GATEWAY_PROXY_PORT, GATEWAY_PROXY_IP, function() {});

    client.on('data', function(data) {
        supportsGateway = true;
        console.log("Gateway proxy connection test successful.");
        client.destroy();
    });

    client.on('error', function(err) {
        supportsGateway = false;
        console.log("Gateway proxy connection failed. Mentions and unreads are not available on this instance.");
        console.log(err);
    });
}

class GatewaySession {
    constructor(token) {
        // console.log("Connected");

        this.token = token;
        this.userID = atob(token.split('.')[0]);
        this.lastReceived = -1;
        this.receiveBuffer = "";

        this.socket = net.Socket();
        this.socket.connect(GATEWAY_PROXY_PORT, GATEWAY_PROXY_IP, function() {});

        this.socket.on('data', (msg) => {
            msg = msg.toString();
            // console.log("Received", msg);
            this.receiveBuffer += msg;

            while (this.receiveBuffer.length) {
                // console.log("REcbuf: '", this.receiveBuffer + "'")
                const receivedMessage = this.receiveBuffer.split('\n')[0];
                try {
                    const msgJson = JSON.parse(receivedMessage);
                    this.receiveBuffer = this.receiveBuffer.slice(receivedMessage.length + 1).trim();//this.receiveBuffer.split('\n').slice(1).join('\n');
                    this.handleMessage(msgJson);
                    // console.log("MSG: " + msgJson)
                } catch (e) {
                    // message got cut off (happens at 65536 characters), wait for the next chunk
                    // console.log(e);
                    return;
                }
            }
        });

        this.socket.on('error', this.handleError);

        this.updateExpiration();
    }

    send(json) {
        // console.log("Sending", json);
        this.socket.write(JSON.stringify(json) + '\n');
    }

    handleMessage(msg) {
        if (msg.s > this.lastReceived) {
            this.lastReceived = msg.s;
        }

        if (msg.op == 10) {
            const heartbeatInterval = msg.d.heartbeat_interval;
                
            this.heartbeat = setInterval(() => {
                if (!this.isValid()) {
                    clearInterval(this.heartbeat);
                    return;
                }

                // console.log("Heartbeat");

                this.send({
                    op: 1,
                    d: (this.lastReceived == -1) ? null : this.lastReceived
                });
            }, heartbeatInterval);

            this.send({
                op: 2,
                d: {
                    token: this.token,
                    capabilities: 30717,
                    properties: {
                        os: "Android",
                        browser: "Discord Android",
                        device: ""
                    }
                }
            });
            return;
        }

        // console.log(msg.t);

        switch (msg.t) {
            case "GATEWAY_HELLO": {
                this.send({
                    op: -1,
                    t: "GATEWAY_CONNECT",
                    d: {
                        supported_events: ["READY", "J2ME_MESSAGE_CREATE", "MESSAGE_ACK"],
                        url: "wss://gateway.discord.gg/?v=9&encoding=json"
                    }
                });
                break;
            }
            case "READY": {
                this.guilds = msg.d.guilds;
                this.privateChannels = msg.d.private_channels;
                this.users = msg.d.users;
                this.notifications = this.parseReadStates(msg);
                break;
            }
            case "J2ME_MESSAGE_CREATE": {
                const mention = this.parseMessage(msg);
                if (!mention) break;

                const existingNotification = this.notifications.find(n => n.channelID == mention.channelID);
                if (existingNotification) {
                    existingNotification.mentionCount++;
                    break;
                }

                this.notifications.push(mention);
                break;
            }
            case "MESSAGE_ACK": {
                if (msg.d.ack_type) break;  // was not a channel being marked as read

                const existingNotification = this.notifications.find(n => n.channelID == msg.d.channel_id);
                
                // no existing notification
                // -> if pings were added by this event (e.g. by selecting "mark unread" in another client), add notification
                if (!existingNotification) {
                    if (msg.d.mention_count) {
                        const info = this.getGuildAndChannelInfo(msg.d.channel_id);
                        this.notifications.push({...info, mentionCount: msg.d.mention_count});
                    }
                    break;
                }

                // existing notification and now channel has no more mentions
                // -> remove notification
                if (!msg.d.mention_count) {
                    this.notifications = this.notifications.filter(n => n.channelID != msg.d.channel_id);
                    break;
                }

                // existing notification and channel's mention count changed
                // -> update notification
                existingNotification.mentionCount = msg.d.mention_count;
                break;
            }
            case "GATEWAY_DISCONNECT": {
                this.handleError(`Gateway disconnected` + (msg.d.message ? `: '${msg.d.message}'` : ''));
                break;
            }
        }
    }

    handleError(err) {
        // console.log(err);
        this.error = err;
        this.close();
    }

    isValid() {
        return Date.now() < this.expires && this.socket;
    }

    updateExpiration() {
        this.expires = Date.now() + 5*60*1000;
    }

    close() {
        // console.log("Disconnected");
        this.socket.destroy();
        this.socket = null;
    }

    getNotifications() {
        // console.log("Requested notifications");

        this.updateExpiration();

        return new Promise((resolve, reject) => {
            const checkNotifications = () => {
                if (this.error) {
                    reject(this.error);
                }
                else if (this.notifications) {
                    resolve(this.notifications);
                }
                else {
                    setTimeout(checkNotifications, 100);
                }
            }
            checkNotifications();
        });
    }

    /**
     * Get ID and name of guild and channel
     * @param {string} channelID the ID of the channel to find
     * @returns object with {guildID, guildName, channelID, channelName}
     */
    getGuildAndChannelInfo(channelID) {
        const guild = this.guilds.find(g => g.channels.some(c => c.id == channelID));

        if (guild) {
            const guildChannel = guild.channels.find(c => c.id == channelID);

            return {
                guildID: guild.id,
                guildName: guild.properties.name,
                channelID,
                channelName: guildChannel.name
            }
        } else {
            // it's a DM
            const dmChannel = this.privateChannels.find(c => c.id == channelID);

            if (!dmChannel) {
                return {
                    channelID,
                    channelName: `(unknown ${channelID})`,
                };
            }

            // groups have name directly
            // for one-to-one DMs and unnamed groups we have to find the recipient name(s) from users
            let dmName = dmChannel.name ??
                dmChannel.recipient_ids.map(r => {
                    const user = this.users.find(u => u.id == r);
                    if (!user) return '(unknown)';
                    return user.global_name ?? user.username;
                }).join(', ');

            // add @ in front if it's one-to-one
            if (dmChannel.type != 3) dmName = '@' + dmName;

            return {
                channelID,
                channelName: dmName,
            }
        }
    }

    /**
     * Parse read state from READY message into list of mentions
     * @param {object} msg Gateway READY event
     * @returns array of mention objects with {guildID, guildName, channelID, channelName, mentionCount}
     */
    parseReadStates(msg) {
        return msg.d.read_state.entries
            .filter(e => e.mention_count != 0)
            .filter(e => !e.read_state_type)  // is an unread message in a channel and not any other type of read state
            .map(e => ({...this.getGuildAndChannelInfo(e.id), mentionCount: e.mention_count}));
    }

    /**
     * Parse new message into a possible mention
     * @param {object} msg Gateway J2ME_MESSAGE_CREATE event
     * @returns object with {guildID, guildName, channelID, channelName, mentionCount}, or null
     */
    parseMessage(msg) {
        const isPing = msg.d.mentions?.some(m => m.id == this.userID);
        if (!isPing) return null;

        return {
            ...this.getGuildAndChannelInfo(msg.d.channel_id),
            mentionCount: 1
        };
    }
}

const gatewaySessions = new Map();

function getExistingSession(token) {
    if (!gatewaySessions.has(token)) return null;

    const session = gatewaySessions.get(token);
    if (session.isValid()) {
        session.updateExpiration();
        return session;
    }
    gatewaySessions.delete(token);
    return null; 
}

function getSession(token) {
    const session = getExistingSession(token);
    if (session) return session;

    const newSession = new GatewaySession(token);
    gatewaySessions.set(token, newSession);
    return newSession;
}

async function getNotifications(token) {
    const session = getSession(token);
    return await session.getNotifications();
}

module.exports = {
    testGateway,
    getNotifications
}