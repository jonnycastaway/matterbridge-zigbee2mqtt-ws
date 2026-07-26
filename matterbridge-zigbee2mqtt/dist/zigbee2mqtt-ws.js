import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage, isErrnoException } from 'matterbridge/utils';
import { AnsiLogger, db, dn, er, gn, hk, id, idn, ign, rs, zb } from 'node-ansi-logger';
import WebSocket from 'ws';
export class Zigbee2MQTTWs extends EventEmitter {
    log;
    wsHost;
    wsPort;
    mqttTopic;
    wsToken;
    wsClient;
    wsIsConnected = false;
    wsIsReconnecting = false;
    wsIsEnding = false;
    wsReconnectTimer;
    wsDataPath = '';
    wsPublishQueue = [];
    wsPublishQueueTimeout;
    wsPublishInflights = 0;
    z2mIsAvailabilityEnabled;
    z2mIsOnline;
    z2mPermitJoin;
    z2mPermitJoinTimeout;
    z2mVersion;
    z2mBridge;
    z2mDevices;
    z2mGroups;
    loggedBridgePayloads = 0;
    loggedPublishPayloads = 0;
    constructor(wsHost, wsPort, mqttTopic, wsToken, debug = false) {
        super();
        this.log = new AnsiLogger({ logName: 'Zigbee2MQTT', logTimestampFormat: 4 /* TimestampFormat.TIME_MILLIS */, logLevel: debug ? "debug" /* LogLevel.DEBUG */ : "info" /* LogLevel.INFO */ });
        this.wsHost = wsHost;
        this.wsPort = wsPort;
        this.mqttTopic = mqttTopic;
        this.wsToken = wsToken;
        this.z2mIsAvailabilityEnabled = false;
        this.z2mIsOnline = false;
        this.z2mPermitJoin = false;
        this.z2mPermitJoinTimeout = 0;
        this.z2mVersion = '';
        this.z2mBridge = undefined;
        this.z2mDevices = [];
        this.z2mGroups = [];
        this.log.debug(`Created new instance with wsHost: ${wsHost} wsPort: ${wsPort} topic: ${mqttTopic} token: ${wsToken !== undefined && wsToken !== '' ? '***' : 'undefined'}`);
    }
    setLogDebug(logDebug) {
        this.log.logLevel = logDebug ? "debug" /* LogLevel.DEBUG */ : "info" /* LogLevel.INFO */;
    }
    setLogLevel(logLevel) {
        this.log.logLevel = logLevel;
    }
    setDataPath(dataPath) {
        try {
            fs.mkdirSync(dataPath, { recursive: true });
            this.wsDataPath = dataPath;
            this.log.debug(`Data directory ${this.wsDataPath} created successfully.`);
        }
        catch (error) {
            if (isErrnoException(error) && error.code === 'EEXIST') {
                this.log.debug('Data directory already exists');
            }
            else {
                this.log.error(`Error creating data directory: ${getErrorMessage(error)}`);
            }
        }
        for (const file of ['bridge-payloads.txt', 'bridge-publish-payloads.txt', 'matter-commands.txt']) {
            try {
                fs.unlinkSync(path.join(this.wsDataPath, file));
            }
            catch {
            }
        }
    }
    getUrl() {
        return `ws://${this.wsHost}:${this.wsPort}/api`;
    }
    start() {
        this.log.debug(`Starting WebSocket connection to ${this.getUrl()}...`);
        this.connectWs();
    }
    connectWs() {
        if (this.wsIsEnding)
            return;
        let url = this.getUrl();
        if (this.wsToken) {
            url += `?token=${encodeURIComponent(this.wsToken)}`;
        }
        this.log.debug(`Connecting to ${url}`);
        this.wsClient = new WebSocket(url);
        this.wsClient.on('open', () => {
            this.log.info(`WebSocket connected to ${this.getUrl()}`);
            this.wsIsConnected = true;
            this.wsIsReconnecting = false;
            this.emit('ws_connected');
        });
        this.wsClient.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                const fullTopic = `${this.mqttTopic}/${msg.topic}`;
                const payloadStr = JSON.stringify(msg.payload);
                this.messageHandler(fullTopic, Buffer.from(payloadStr));
            }
            catch (err) {
                this.log.error(`Error parsing WebSocket message: ${err}`);
            }
        });
        this.wsClient.on('close', () => {
            this.log.warn('WebSocket connection closed');
            this.wsIsConnected = false;
            this.wsClient = undefined;
            this.emit('ws_close');
            if (!this.wsIsEnding) {
                this.wsIsReconnecting = true;
                this.emit('ws_reconnect');
                this.wsReconnectTimer = setTimeout(() => this.connectWs(), 5000);
            }
        });
        this.wsClient.on('error', (err) => {
            this.log.error(`WebSocket error: ${err.message}`);
            this.emit('ws_error', err);
        });
    }
    stop() {
        this.wsIsEnding = true;
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = undefined;
        }
        if (this.wsPublishQueueTimeout) {
            clearInterval(this.wsPublishQueueTimeout);
            this.wsPublishQueueTimeout = undefined;
        }
        if (!this.wsClient) {
            this.log.debug('Already stopped!');
            return;
        }
        this.log.debug('Closing WebSocket connection...');
        this.wsClient.close();
        this.wsClient.removeAllListeners();
        this.wsClient = undefined;
        this.wsIsConnected = false;
        this.wsIsReconnecting = false;
        this.wsIsEnding = false;
        this.log.debug('WebSocket connection closed');
    }
    subscribe(_topic) {
        this.log.debug('WebSocket mode: no subscribe needed, all messages are pushed by the server');
        this.emit('ws_subscribed');
    }
    publish(topic, message, queue = false) {
        const wsTopic = topic.startsWith(`${this.mqttTopic}/`) ? topic.slice(this.mqttTopic.length + 1) : topic;
        const payload = (() => {
            try {
                return JSON.parse(message);
            }
            catch {
                return message;
            }
        })();
        const wsMsg = JSON.stringify({ topic: wsTopic, payload });
        const doSend = () => {
            if (this.wsClient && this.wsIsConnected && this.wsClient.readyState === WebSocket.OPEN) {
                this.log.debug(`WebSocket send topic: ${wsTopic} message: ${message}`);
                this.wsPublishInflights++;
                this.wsClient.send(wsMsg, (err) => {
                    if (err)
                        this.log.error(`WebSocket send error: ${err.message}`);
                    this.wsPublishInflights--;
                    if (!err)
                        this.emit('ws_published');
                });
            }
            else {
                this.log.error('Unable to publish, WebSocket not connected');
            }
        };
        if (queue) {
            this.wsPublishQueue.push({ topic, message });
            if (!this.wsPublishQueueTimeout) {
                this.wsPublishQueueTimeout = setInterval(() => {
                    if (this.wsPublishQueue.length > 0) {
                        const item = this.wsPublishQueue.shift();
                        if (this.wsClient && this.wsIsConnected) {
                            const t = item.topic.startsWith(`${this.mqttTopic}/`) ? item.topic.slice(this.mqttTopic.length + 1) : item.topic;
                            const p = (() => { try {
                                return JSON.parse(item.message);
                            }
                            catch {
                                return item.message;
                            } })();
                            this.wsClient.send(JSON.stringify({ topic: t, payload: p }), (err) => {
                                if (err)
                                    this.log.error(`WebSocket queue send error: ${err.message}`);
                            });
                        }
                    }
                    else {
                        clearInterval(this.wsPublishQueueTimeout);
                        this.wsPublishQueueTimeout = undefined;
                    }
                }, 50);
            }
            return;
        }
        doSend();
    }
    writeBufferJSON(file, buffer) {
        const filePath = path.join(this.wsDataPath, file);
        let jsonData;
        try {
            jsonData = this.tryJsonParse(buffer.toString());
        }
        catch (error) {
            this.log.error('writeBufferJSON: parsing error:', error);
            return;
        }
        fs.promises
            .writeFile(`${filePath}.json`, JSON.stringify(jsonData, null, 2))
            .then(() => this.log.debug(`Successfully wrote to ${filePath}.json`))
            .catch((error) => this.log.error(`Error writing to ${filePath}.json:`, error));
    }
    writeFile(file, data) {
        const filePath = path.join(this.wsDataPath, file);
        fs.promises
            .writeFile(filePath, data)
            .then(() => this.log.debug(`Successfully wrote to ${filePath}`))
            .catch((error) => this.log.error(`Error writing to ${filePath}:`, error));
    }
    // oxlint-disable-next-line typescript/no-explicit-any
    tryJsonParse(text) {
        try {
            return JSON.parse(text);
        }
        catch (error) {
            this.log.debug(`tryJsonParse: parsing error from ${text}`);
            this.log.error('tryJsonParse: parsing error:', error);
            return {};
        }
    }
    messageHandler(topic, payload) {
        if (topic.startsWith(this.mqttTopic + '/bridge/state')) {
            const payloadString = payload.toString();
            let data;
            if (payloadString.startsWith('{') && payloadString.endsWith('}')) {
                data = this.tryJsonParse(payload.toString());
            }
            else {
                data = { state: payloadString };
            }
            if (data.state === 'online') {
                this.z2mIsOnline = true;
                this.emit('online');
            }
            else if (data.state === 'offline') {
                this.z2mIsOnline = false;
                this.emit('offline');
            }
            this.log.debug(`Message bridge/state online => ${this.z2mIsOnline}`);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/info')) {
            this.z2mBridge = this.tryJsonParse(payload.toString());
            this.z2mPermitJoin = this.z2mBridge.permit_join;
            this.z2mPermitJoinTimeout = this.z2mBridge.permit_join_timeout;
            this.z2mVersion = this.z2mBridge.version;
            this.z2mIsAvailabilityEnabled = this.z2mBridge.config.availability !== undefined;
            this.log.debug(`Message bridge/info availability => ${this.z2mIsAvailabilityEnabled}`);
            this.log.debug(`Message bridge/info version => ${this.z2mVersion}`);
            this.log.debug(`Message bridge/info permit_join => ${this.z2mPermitJoin} timeout => ${this.z2mPermitJoinTimeout}`);
            this.log.debug(`Message bridge/info advanced.output => ${this.z2mBridge.config.advanced.output}`);
            this.log.debug(`Message bridge/info advanced.legacy_api => ${this.z2mBridge.config.advanced.legacy_api}`);
            this.log.debug(`Message bridge/info advanced.legacy_availability_payload => ${this.z2mBridge.config.advanced.legacy_availability_payload}`);
            if (this.z2mBridge.config.advanced.output === 'attribute')
                this.log.error(`Message bridge/info advanced.output must be 'json' or 'attribute_and_json'. Now is ${this.z2mBridge.config.advanced.output}`);
            if (this.z2mBridge.config.advanced.legacy_api)
                this.log.info(`Message bridge/info advanced.legacy_api is ${this.z2mBridge.config.advanced.legacy_api}`);
            if (this.z2mBridge.config.advanced.legacy_availability_payload)
                this.log.info(`Message bridge/info advanced.legacy_availability_payload is ${this.z2mBridge.config.advanced.legacy_availability_payload}`);
            this.emit('bridge-info', this.z2mBridge);
            if (this.log.logLevel === "debug" /* LogLevel.DEBUG */)
                this.writeBufferJSON('bridge-info', payload);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/devices')) {
            if (this.log.logLevel === "debug" /* LogLevel.DEBUG */)
                this.writeBufferJSON('bridge-devices', payload);
            this.z2mDevices = this.tryJsonParse(payload.toString());
            this.emit('bridge-devices', this.z2mDevices);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/groups')) {
            if (this.log.logLevel === "debug" /* LogLevel.DEBUG */)
                this.writeBufferJSON('bridge-groups', payload);
            this.z2mGroups = this.tryJsonParse(payload.toString());
            this.emit('bridge-groups', this.z2mGroups);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/extensions')) {
            const extensions = this.tryJsonParse(payload.toString());
            for (const extension of extensions) {
                this.log.debug(`Message topic: ${topic} extension: ${extension.name}`);
            }
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/event')) {
            this.handleEvent(payload);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/request')) {
            const data = this.tryJsonParse(payload.toString());
            this.log.info(`Message topic: ${topic} payload:${rs}`, data);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/response')) {
            if (topic.startsWith(this.mqttTopic + '/bridge/response/networkmap')) {
                this.handleResponseNetworkmap(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/permit_join')) {
                this.handleResponsePermitJoin(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/device/rename')) {
                this.handleResponseDeviceRename(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/device/remove')) {
                this.handleResponseDeviceRemove(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/device/options')) {
                this.handleResponseDeviceOptions(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/group/add')) {
                this.handleResponseGroupAdd(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/group/remove')) {
                this.handleResponseGroupRemove(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/group/rename')) {
                this.handleResponseGroupRename(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/group/members/add')) {
                this.handleResponseGroupAddMember(payload);
                return;
            }
            if (topic.startsWith(this.mqttTopic + '/bridge/response/group/members/remove')) {
                this.handleResponseGroupRemoveMember(payload);
                return;
            }
            const data = this.tryJsonParse(payload.toString());
            this.log.debug(`Message topic: ${topic} payload:${rs}`, data);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/logging')) {
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/config')) {
            this.log.debug(`Message topic: ${topic}`);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/definitions')) {
            this.log.debug(`Message topic: ${topic}`);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge')) {
            this.log.debug(`Message topic: ${topic}`);
        }
        else {
            let entity = topic.replace(this.mqttTopic + '/', '');
            let service = '';
            if (entity.search('/')) {
                const parts = entity.split('/');
                entity = parts[0];
                service = parts[1];
            }
            if (entity === 'Coordinator') {
                const data = this.tryJsonParse(payload.toString());
                if (service === 'availability') {
                    if (data.state === 'online') {
                        this.log.debug(`Received ONLINE for ${id}Coordinator${rs}`, data);
                    }
                    else if (data.state === 'offline') {
                        this.log.debug(`Received OFFLINE for ${id}Coordinator${rs}`, data);
                    }
                }
                return;
            }
            if (this.log.logLevel === "debug" /* LogLevel.DEBUG */ && this.loggedBridgePayloads < 10000) {
                const logEntry = { entity, service, payload: payload.toString() };
                const filePath = path.join(this.wsDataPath, 'bridge-payloads.txt');
                fs.appendFileSync(filePath, `${new Date().toLocaleString()} - ` + JSON.stringify(logEntry).replaceAll('\\"', '"') + '\n');
                this.loggedBridgePayloads++;
            }
            const foundDevice = this.z2mDevices.find((device) => device.ieee_address === entity || device.friendly_name === entity);
            if (foundDevice) {
                this.handleDeviceMessage(foundDevice, entity, service, payload);
            }
            else {
                const foundGroup = this.z2mGroups.find((group) => group.friendly_name === entity);
                if (foundGroup) {
                    this.handleGroupMessage(foundGroup, entity, service, payload);
                }
                else {
                    this.log.debug('Message for ***unknown*** entity:', entity, 'service:', service, 'payload:', payload);
                }
            }
        }
    }
    handleDeviceMessage(device, entity, service, payload) {
        if (!payload || payload.length === 0)
            return;
        const payloadString = payload.toString();
        let data;
        if (payloadString.startsWith('{') && payloadString.endsWith('}')) {
            data = this.tryJsonParse(payload.toString());
        }
        else {
            data = { state: payloadString };
        }
        if (service === 'availability') {
            if (data.state === 'online') {
                this.emit('availability', entity, true);
                this.emit('ONLINE-' + entity);
            }
            else if (data.state === 'offline') {
                this.emit('availability', entity, false);
                this.emit('OFFLINE-' + entity);
            }
        }
        else if (service === 'get') {
        }
        else if (service === 'set') {
        }
        else if (service === undefined) {
            this.emit('message', entity, data);
            this.emit('MESSAGE-' + entity, data);
        }
        else {
        }
    }
    handleGroupMessage(group, entity, service, payload) {
        if (!payload || payload.length === 0)
            return;
        const payloadString = payload.toString();
        let data;
        if (payloadString.startsWith('{') && payloadString.endsWith('}')) {
            data = this.tryJsonParse(payload.toString());
        }
        else {
            data = { state: payloadString };
        }
        data['last_seen'] = new Date().toISOString();
        if (service === 'availability') {
            if (data.state === 'online') {
                this.emit('availability', entity, true);
                this.emit('ONLINE-' + entity);
            }
            else if (data.state === 'offline') {
                this.emit('availability', entity, false);
                this.emit('OFFLINE-' + entity);
            }
        }
        else if (service === 'get') {
        }
        else if (service === 'set') {
        }
        else if (service === undefined) {
            this.emit('MESSAGE-' + entity, data);
        }
        else {
        }
    }
    handleResponseNetworkmap(payload) {
        const data = this.tryJsonParse(payload.toString());
        const topology = data.data.value;
        const lqi = (lqi) => {
            if (lqi < 50)
                return `\x1b[31m${lqi.toString().padStart(3, ' ')}${db}`;
            else if (lqi > 200)
                return `\x1b[32m${lqi.toString().padStart(3, ' ')}${db}`;
            else
                return `\x1b[38;5;251m${lqi.toString().padStart(3, ' ')}${db}`;
        };
        const depth = (depth) => {
            if (depth === 255)
                return `\x1b[32m${depth.toString().padStart(3, ' ')}${db}`;
            else
                return `\x1b[38;5;251m${depth.toString().padStart(3, ' ')}${db}`;
        };
        const relationship = (relationship) => {
            if (relationship === 0)
                return `${zb}${relationship}-IsParent  ${db}`;
            else if (relationship === 1)
                return `${hk}${relationship}-IsAChild  ${db}`;
            else
                return `${relationship}-IsASibling`;
        };
        const friendlyName = (ieeeAddr) => {
            const node = topology.nodes.find((node) => node.ieeeAddr === ieeeAddr);
            if (node) {
                if (node.type === 'Coordinator')
                    return `\x1b[48;5;1m\x1b[38;5;255m${node.friendlyName} [C]${rs}${db}`;
                else if (node.type === 'Router')
                    return `${dn}${node.friendlyName} [R]${db}`;
                else if (node.type === 'EndDevice')
                    return `${gn}${node.friendlyName} [E]${db}`;
            }
            return `${er}${ieeeAddr}${db}`;
        };
        const timePassedSince = (lastSeen) => {
            const now = Date.now();
            const difference = now - lastSeen;
            const days = Math.floor(difference / (1000 * 60 * 60 * 24));
            if (days > 0)
                return `${days} days ago`;
            const hours = Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            if (hours > 0)
                return `${hours} hours ago`;
            const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
            if (minutes > 0)
                return `${minutes} minutes ago`;
            const seconds = Math.floor((difference % (1000 * 60)) / 1000);
            return `${seconds} seconds ago`;
        };
        if (this.log.logLevel === "debug" /* LogLevel.DEBUG */)
            this.writeBufferJSON('networkmap_' + data.data.type, payload);
        if (data.data.type === 'graphviz') {
            if (this.log.logLevel === "debug" /* LogLevel.DEBUG */)
                this.writeFile('networkmap_' + data.data.type + '.txt', data.data.value);
        }
        if (data.data.type === 'plantuml') {
            if (this.log.logLevel === "debug" /* LogLevel.DEBUG */)
                this.writeFile('networkmap_' + data.data.type + '.txt', data.data.value);
        }
        if (data.data.type === 'raw') {
            this.log.warn('Network map nodes:');
            topology.nodes.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
            topology.nodes.forEach((node, index) => {
                this.log.debug(`Node [${index.toString().padStart(3, ' ')}] ${node.type === 'EndDevice' ? ign : node.type === 'Router' ? idn : '\x1b[48;5;1m\x1b[38;5;255m'}${node.friendlyName}${rs}${db} addr: ${node.ieeeAddr}-0x${node.networkAddress.toString(16)} type: ${node.type} lastseen: ${timePassedSince(node.lastSeen)}`);
                const sourceLinks = topology.links.filter((link) => link.sourceIeeeAddr === node.ieeeAddr);
                sourceLinks.sort((a, b) => a.lqi - b.lqi);
                sourceLinks.forEach((link, index) => {
                    this.log.debug(`  link [${index.toString().padStart(4, ' ')}] lqi: ${lqi(link.lqi)} depth: ${depth(link.depth)} relation: ${relationship(link.relationship)} > > > ${friendlyName(link.target.ieeeAddr)}`);
                });
                const targetLinks = topology.links.filter((link) => link.targetIeeeAddr === node.ieeeAddr);
                targetLinks.sort((a, b) => a.lqi - b.lqi);
                targetLinks.forEach((link, index) => {
                    this.log.debug(`  link [${index.toString().padStart(4, ' ')}] lqi: ${lqi(link.lqi)} depth: ${depth(link.depth)} relation: ${relationship(link.relationship)} < < < ${friendlyName(link.source.ieeeAddr)}`);
                });
            });
        }
    }
    handleResponseDeviceRename(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseDeviceRename from ${json.data.from} to ${json.data.to} status ${json.status}`);
        const device = this.z2mDevices.find((device) => device.friendly_name === json.data.to);
        this.emit('device_rename', device?.ieee_address, json.data.from, json.data.to);
    }
    handleResponseDeviceRemove(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseDeviceRemove name ${json.data.id} status ${json.status} block ${json.data.block} force ${json.data.force}`);
        this.emit('device_remove', json.data.id, json.status, json.data.block, json.data.force);
    }
    handleResponseDeviceOptions(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseDeviceOptions ieee_address ${json.data.id} status ${json.status} from ${json.data.from} to ${json.data.to}`);
        this.emit('device_options', json.data.id, json.status, json.data.from, json.data.to);
    }
    handleResponseGroupAdd(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseGroupAdd() friendly_name ${json.data.friendly_name} id ${json.data.id} status ${json.status}`);
        if (json.status === 'ok') {
            this.emit('group_add', json.data.friendly_name, json.data.id, json.status);
        }
    }
    handleResponseGroupRemove(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseGroupRemove() friendly_name ${json.data.id} status ${json.status}`);
        if (json.status === 'ok') {
            this.emit('group_remove', json.data.id, json.status);
        }
    }
    handleResponseGroupRename(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseGroupRename() from ${json.data.from} to ${json.data.to} status ${json.status}`);
        if (json.status === 'ok') {
            this.emit('group_rename', json.data.from, json.data.to, json.status);
        }
    }
    handleResponseGroupAddMember(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseGroupAddMembers() add to group friendly_name ${json.data.group} device ieee_address ${json.data.device} status ${json.status}`);
        if (json.status === 'ok' && json.data.device?.includes('/')) {
            this.emit('group_add_member', json.data.group, json.data.device.split('/')[0], json.status);
        }
    }
    handleResponseGroupRemoveMember(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponseGroupRemoveMember() remove from group friendly_name ${json.data.group} device friendly_name ${json.data.device} status ${json.status}`);
        if (json.status === 'ok') {
            this.emit('group_remove_member', json.data.group, json.data.device, json.status);
        }
    }
    handleResponsePermitJoin(payload) {
        const json = this.tryJsonParse(payload.toString());
        this.log.debug(`handleResponsePermitJoin() device: ${json.data.device ? json.data.device : 'All'} time: ${json.data.time} value: ${json.data.value} status: ${json.status}`);
        if (json.status === 'ok') {
            this.emit('permit_join', json.data.device, json.data.time, json.data.value);
        }
    }
    handleEvent(payload) {
        const json = this.tryJsonParse(payload.toString());
        switch (json.type) {
            case undefined:
                this.log.error('handleEvent() undefined type', json);
                break;
            case 'device_leave':
                this.log.debug(`handleEvent() type: device_leave name: ${json.data.friendly_name} address: ${json.data.ieee_address}`);
                this.emit('device_leave', json.data.friendly_name, json.data.ieee_address);
                break;
            case 'device_joined':
                this.log.debug(`handleEvent() type: device_joined name: ${json.data.friendly_name} address: ${json.data.ieee_address}`);
                this.emit('device_joined', json.data.friendly_name, json.data.ieee_address);
                break;
            case 'device_announce':
                this.log.debug(`handleEvent() type: device_announce name: ${json.data.friendly_name} address: ${json.data.ieee_address}`);
                this.emit('device_announce', json.data.friendly_name, json.data.ieee_address);
                break;
            case 'device_interview':
                this.log.debug(`handleEvent() type: device_interview name: ${json.data.friendly_name} address: ${json.data.ieee_address} status: ${json.data.status} supported: ${json.data.supported}`);
                this.emit('device_interview', json.data.friendly_name, json.data.ieee_address, json.data.status, json.data.supported);
                break;
            default:
        }
    }
    readConfig(filename) {
        this.log.debug(`Reading config from ${filename}`);
        try {
            const rawdata = fs.readFileSync(filename, 'utf-8');
            const data = this.tryJsonParse(rawdata);
            return data;
        }
        catch (err) {
            this.log.error('readConfig error', err);
            return null;
        }
    }
    writeConfig(filename, data) {
        this.log.debug(`Writing config to ${filename}`);
        try {
            const jsonString = JSON.stringify(data, null, 2);
            fs.writeFileSync(filename, jsonString);
            return true;
        }
        catch (err) {
            this.log.error('writeConfig error', err);
            return false;
        }
    }
    emitPayload(entity, data) {
        this.emit('MESSAGE-' + entity, data);
    }
}
//# sourceMappingURL=zigbee2mqtt-ws.js.map