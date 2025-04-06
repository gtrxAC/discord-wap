# Discord WAP
Discord proxy client for old mobile browsers with Wireless Application Protocol 1.x support.

Also see [Discord J2ME](https://github.com/gtrxAC/discord-j2me), a client for devices with Java ME (MIDP) application support.

## Status
### Working
* Server, channel, and DM lists
  * Note: due to page size limitations, not all channels are shown
* Message sending
* Replying with ping on or off
* Message history with pagination
### Not implemented
* HTML support
* Message editing and deleting
* Threads
* Message timestamps
* Settings (e.g. message load count)

## How to use
A public instance is hosted at http://146.59.80.3/wap, but it is recommended to host your own instance if possible.

You will need:
* A Discord account
* A way to get that account's token (either a PC or an Android device with the Puffin browser installed)
* A phone that supports WAP 1.x, WML 1.1 or higher, and a data transfer technology that is available in your region (usually GPRS).

Steps:
* Get your account's token using, for example, [this guide](https://github.com/NotNexuss/Get-Discord-Token).
* Configure your phone's internet access point settings. In particular, set the APN (access point name) to your carrier's APN, and set the WAP gateway's IP address to one of the IPs listed [here](https://nbpfan.bs0dd.net/index.php?lang=eng&page=wap%2Fmain).
* Go to your phone's browser and enter the instance's address, for example `http://146.59.80.3/wap`.
* When the page loads, enter your account's token and select `Log in`.
* For quick access in the future, you should add the main menu (Servers/DMs selection) to your bookmarks. This bookmark will contain your account's token.

## Self-hosting
1. Install [Node.js](https://nodejs.org).
2. Clone this repository.
3. Change the port number near the beginning of the `index.js` file, if necessary.
4. Open a terminal in the folder of the cloned repository.
5. Run `npm i` and `node .`
