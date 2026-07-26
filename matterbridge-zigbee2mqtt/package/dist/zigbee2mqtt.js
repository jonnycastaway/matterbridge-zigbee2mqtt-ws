import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage, isErrnoException } from 'matterbridge/utils';
import { connectAsync } from 'mqtt';
import { AnsiLogger, db, dn, er, gn, hk, id, idn, ign, REVERSE, REVERSEOFF, rs, zb } from 'node-ansi-logger';
export class Zigbee2MQTT extends EventEmitter {
    log;
    mqttHost;
    mqttPort;
    mqttTopic;
    mqttUsername;
    mqttPassword;
    mqttClient;
    mqttIsConnected = false;
    mqttIsReconnecting = false;
    mqttIsEnding = false;
    mqttDataPath = '';
    mqttPublishQueue = [];
    mqttPublishQueueTimeout = undefined;
    mqttPublishInflights = 0;
    mqttKeepaliveInterval = undefined;
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
    options = {
        clientId: 'matterbridge_' + crypto.randomBytes(8).toString('hex'),
        keepalive: 60,
        protocolVersion: 5,
        reconnectPeriod: 5000,
        connectTimeout: 60 * 1000,
        username: undefined,
        password: undefined,
        clean: true,
    };
    constructor(mqttHost, mqttPort, mqttTopic, mqttUsername, mqttPassword, mqttClientId, protocolVersion = 5, ca, rejectUnauthorized, cert, key, debug = false) {
        super();
        this.log = new AnsiLogger({ logName: 'Zigbee2MQTT', logTimestampFormat: 4, logLevel: debug ? "debug" : "info" });
        this.mqttHost = mqttHost;
        this.mqttPort = mqttPort;
        this.mqttTopic = mqttTopic;
        this.mqttUsername = mqttUsername;
        this.mqttPassword = mqttPassword;
        this.options.username = mqttUsername !== undefined && mqttUsername !== '' ? mqttUsername : undefined;
        this.options.password = mqttPassword !== undefined && mqttPassword !== '' ? mqttPassword : undefined;
        if (mqttClientId)
            this.options.clientId = mqttClientId;
        this.options.protocolVersion = protocolVersion;
        if (mqttHost.startsWith('mqtts://') || mqttHost.startsWith('wss://')) {
            this.log.debug('Using mqtts:// protocol for secure MQTT connection');
            if (ca) {
                try {
                    fs.accessSync(ca, fs.constants.R_OK);
                    this.options.ca = fs.readFileSync(ca);
                    this.log.info(`Successfully read the CA certificate from ${ca}`);
                }
                catch (error) {
                    this.log.error(`Error reading the CA certificate from ${ca}:`, error);
                }
            }
            else {
                this.log.info('When using mqtts:// protocol, you must provide the ca certificate for SSL/TLS connections with self-signed certificates.');
            }
            this.options.rejectUnauthorized = rejectUnauthorized;
            this.log.info(`TLS rejectUnauthorized is set to ${this.options.rejectUnauthorized}`);
            if (cert && key) {
                try {
                    fs.accessSync(cert, fs.constants.R_OK);
                    this.options.cert = fs.readFileSync(cert);
                    this.log.info(`Successfully read the client certificate from ${cert}`);
                }
                catch (error) {
                    this.log.error(`Error reading the client certificate from ${cert}:`, error);
                }
                try {
                    fs.accessSync(key, fs.constants.R_OK);
                    this.options.key = fs.readFileSync(key);
                    this.log.info(`Successfully read the client key from ${key}`);
                }
                catch (error) {
                    this.log.error(`Error reading the client key from ${key}:`, error);
                }
            }
        }
        else if (mqttHost.startsWith('mqtt://') || mqttHost.startsWith('ws://')) {
            this.log.debug('Using mqtt:// protocol for non-secure MQTT connection');
            if (ca) {
                this.log.warn('You are using mqtt:// protocol, but you provided a CA certificate. It will be ignored.');
            }
            if (cert) {
                this.log.warn('You are using mqtt:// protocol, but you provided a certificate. It will be ignored.');
            }
            if (key) {
                this.log.warn('You are using mqtt:// protocol, but you provided a key. It will be ignored.');
            }
        }
        else if (mqttHost.startsWith('mqtt+unix://')) {
            this.log.debug('Using mqtt+unix:// protocol for MQTT connection over Unix socket');
            if (ca) {
                this.log.warn('You are using mqtt+unix:// protocol, but you provided a CA certificate. It will be ignored.');
            }
            if (cert) {
                this.log.warn('You are using mqtt+unix:// protocol, but you provided a certificate. It will be ignored.');
            }
            if (key) {
                this.log.warn('You are using mqtt+unix:// protocol, but you provided a key. It will be ignored.');
            }
        }
        else {
            this.log.warn('You are using an unsupported MQTT protocol. Please use mqtt:// or mqtts:// or ws:// or wss:// or mqtt+unix://.');
        }
        this.z2mIsAvailabilityEnabled = false;
        this.z2mIsOnline = false;
        this.z2mPermitJoin = false;
        this.z2mPermitJoinTimeout = 0;
        this.z2mVersion = '';
        this.z2mBridge = undefined;
        this.z2mDevices = [];
        this.z2mGroups = [];
        this.log.debug(`Created new instance with host: ${mqttHost} port: ${mqttPort} protocol ${protocolVersion} topic: ${mqttTopic} username: ${mqttUsername !== undefined && mqttUsername !== '' ? mqttUsername : 'undefined'} password: ${mqttPassword !== undefined && mqttPassword !== '' ? '*****' : 'undefined'}`);
    }
    setLogDebug(logDebug) {
        this.log.logLevel = logDebug ? "debug" : "info";
    }
    setLogLevel(logLevel) {
        this.log.logLevel = logLevel;
    }
    setDataPath(dataPath) {
        try {
            fs.mkdirSync(dataPath, { recursive: true });
            this.mqttDataPath = dataPath;
            this.log.debug(`Data directory ${this.mqttDataPath} created successfully.`);
        }
        catch (error) {
            if (isErrnoException(error) && error.code === 'EEXIST') {
                this.log.debug('Data directory already exists');
            }
            else {
                this.log.error(`Error creating data directory: ${getErrorMessage(error)}`);
            }
        }
        try {
            const filePath = path.join(this.mqttDataPath, 'bridge-payloads.txt');
            fs.unlinkSync(filePath);
        }
        catch (error) {
            this.log.debug(`Error deleting bridge-payloads.txt: ${getErrorMessage(error)}`);
        }
        try {
            const filePath = path.join(this.mqttDataPath, 'bridge-publish-payloads.txt');
            fs.unlinkSync(filePath);
        }
        catch (error) {
            this.log.debug(`Error deleting bridge-publish-payloads.txt: ${getErrorMessage(error)}`);
        }
        try {
            const filePath = path.join(this.mqttDataPath, 'matter-commands.txt');
            fs.unlinkSync(filePath);
        }
        catch (error) {
            this.log.debug(`Error deleting matter-commands.txt: ${getErrorMessage(error)}`);
        }
    }
    getUrl() {
        return this.mqttHost.includes('unix://') ? this.mqttHost : this.mqttHost + ':' + this.mqttPort.toString();
    }
    start() {
        this.log.debug(`Starting connection to ${this.getUrl()}...`);
        connectAsync(this.getUrl(), this.options)
            .then((client) => {
            this.log.debug('Connection established');
            this.mqttClient = client;
            this.mqttClient.on('connect', (packet) => {
                this.log.debug(`MQTT client connect to ${this.getUrl()}${rs}`);
                this.mqttIsConnected = true;
                this.mqttIsReconnecting = false;
                this.mqttIsEnding = false;
                this.emit('mqtt_connect');
            });
            this.mqttClient.on('reconnect', () => {
                this.log.debug(`MQTT client reconnect to ${this.getUrl()}${rs}`);
                this.mqttIsReconnecting = true;
                this.emit('mqtt_reconnect');
            });
            this.mqttClient.on('disconnect', (packet) => {
                this.log.debug('MQTT client diconnect', this.getUrl(), packet);
                this.emit('mqtt_disconnect');
            });
            this.mqttClient.on('close', () => {
                this.log.debug('MQTT client close');
                this.mqttIsConnected = false;
                this.mqttIsReconnecting = false;
                this.emit('mqtt_close');
            });
            this.mqttClient.on('end', () => {
                this.log.debug('MQTT client end');
                this.mqttIsConnected = false;
                this.mqttIsReconnecting = false;
                this.emit('mqtt_end');
            });
            this.mqttClient.on('offline', () => {
                this.log.debug('MQTT client offline');
                this.emit('mqtt_offline');
            });
            this.mqttClient.on('error', (error) => {
                this.log.debug('MQTT client error', error);
                this.emit('mqtt_error', error);
            });
            this.mqttClient.on('packetsend', (packet) => {
            });
            this.mqttClient.on('packetreceive', (packet) => {
            });
            this.mqttClient.on('message', (topic, payload, packet) => {
                this.messageHandler(topic, payload);
            });
            this.log.debug('Started');
            this.mqttIsConnected = true;
            this.mqttIsReconnecting = false;
            this.mqttIsEnding = false;
            this.emit('mqtt_connect');
            this.mqttKeepaliveInterval = setInterval(() => {
                this.log.debug('Publishing keepalive MQTT message');
                this.mqttClient?.publishAsync(`clients/${this.options.clientId}/heartbeat`, 'alive', { qos: 2 }).catch((error) => {
                    this.log.error(`Error publishing keepalive MQTT message: ${getErrorMessage(error)}`);
                });
            }, (this.options.keepalive ?? 60) * 1000).unref();
            return;
        })
            .catch((error) => {
            this.log.error(`Error connecting to ${this.getUrl()}: ${getErrorMessage(error)}`);
            this.emit('mqtt_error', error);
        });
    }
    stop() {
        if (this.mqttKeepaliveInterval) {
            clearInterval(this.mqttKeepaliveInterval);
            this.mqttKeepaliveInterval = undefined;
        }
        if (!this.mqttClient || this.mqttIsEnding) {
            this.log.debug('Already stopped!');
        }
        else {
            this.mqttIsEnding = true;
            this.log.debug('Ending connection...');
            this.mqttClient
                .endAsync(false)
                .then(() => {
                this.mqttClient?.removeAllListeners();
                this.mqttIsConnected = false;
                this.mqttIsReconnecting = false;
                this.mqttIsEnding = false;
                this.mqttClient = undefined;
                this.log.debug('Connection closed');
                return;
            })
                .catch((error) => {
                this.log.error(`Error closing connection: ${getErrorMessage(error)}`);
            });
        }
    }
    subscribe(topic) {
        if (this.mqttClient && this.mqttIsConnected) {
            this.log.debug(`Subscribing topic: ${topic}`);
            this.mqttClient
                .subscribeAsync(topic, { qos: 2 })
                .then(() => {
                this.log.debug(`Subscribe success on topic: ${topic}`);
                this.emit('mqtt_subscribed');
                return;
            })
                .catch((error) => {
                this.log.error(`Subscribe error: ${getErrorMessage(error)} on topic: ${topic}`);
            });
        }
        else {
            this.log.error('Unable to subscribe, client not connected or unavailable');
        }
    }
    publish(topic, message, queue = false) {
        const startInterval = () => {
            if (this.mqttPublishQueueTimeout) {
                return;
            }
            this.log.debug(`**Start publish ${REVERSE}[${this.mqttPublishQueue.length}-${this.mqttPublishInflights}]${REVERSEOFF} interval`);
            this.mqttPublishQueueTimeout = setInterval(() => {
                if (this.mqttClient && this.mqttPublishQueue.length > 0) {
                    this.log.debug(`**Publish ${REVERSE}[${this.mqttPublishQueue.length}-${this.mqttPublishInflights}]${REVERSEOFF} topic: ${this.mqttPublishQueue[0].topic} message: ${this.mqttPublishQueue[0].message}${rs}`);
                    this.mqttPublishInflights++;
                    this.mqttClient
                        .publishAsync(this.mqttPublishQueue[0].topic, this.mqttPublishQueue[0].message, { qos: 2 })
                        .then(() => {
                        this.log.debug(`**Publish ${REVERSE}[${this.mqttPublishQueue.length}-${this.mqttPublishInflights}]${REVERSEOFF} success on topic: ${topic} message: ${message} inflights: ${this.mqttPublishInflights}`);
                        this.emit('mqtt_published');
                        this.mqttPublishInflights--;
                    })
                        .catch((error) => {
                        this.mqttPublishInflights--;
                        this.log.error(`****Publish ${REVERSE}[${this.mqttPublishQueue.length}-${this.mqttPublishInflights}]${REVERSEOFF} error: ${getErrorMessage(error)} on topic: ${topic} message: ${message} inflights: ${this.mqttPublishInflights}`);
                    })
                        .finally(() => {
                        this.mqttPublishQueue.splice(0, 1);
                    });
                }
                else {
                    stopInterval();
                }
            }, 50);
        };
        const stopInterval = () => {
            if (this.mqttPublishQueueTimeout) {
                this.log.debug(`**Stop publish ${REVERSE}[${this.mqttPublishQueue.length}-${this.mqttPublishInflights}]${REVERSEOFF} interval`);
                clearInterval(this.mqttPublishQueueTimeout);
                this.mqttPublishQueueTimeout = undefined;
            }
        };
        if (this.mqttClient && this.mqttIsConnected) {
            if (queue) {
                startInterval();
                this.mqttPublishQueue.push({ topic: topic, message: message });
                this.log.debug(`**Add to publish ${REVERSE}[${this.mqttPublishQueue.length}-${this.mqttPublishInflights}]${REVERSEOFF} topic: ${topic} message: ${message}${rs}`);
                return;
            }
            this.log.debug(`Publishing ${REVERSE}[${this.mqttPublishInflights}]${REVERSEOFF} topic: ${topic} message: ${message}`);
            this.mqttPublishInflights++;
            this.mqttClient
                .publishAsync(topic, message, { qos: 2 })
                .then(() => {
                this.log.debug(`Publish ${REVERSE}[${this.mqttPublishInflights}]${REVERSEOFF} success on topic: ${topic} message: ${message}`);
                this.emit('mqtt_published');
                if (this.log.logLevel === "debug" && this.loggedPublishPayloads < 10000) {
                    const filePath = path.join(this.mqttDataPath, 'bridge-publish-payloads.txt');
                    fs.appendFileSync(filePath, `${new Date().toLocaleString()} - ` + JSON.stringify({ topic, message }).replaceAll('\\"', '"') + '\n');
                    this.loggedPublishPayloads++;
                }
            })
                .catch((error) => {
                this.log.error(`****Publish ${REVERSE}[${this.mqttPublishInflights}]${REVERSEOFF} error: ${getErrorMessage(error)} on topic: ${topic} message: ${message}`);
            })
                .finally(() => {
                this.mqttPublishInflights--;
            });
        }
        else {
            this.log.error('Unable to publish, client not connected or unavailable.');
        }
    }
    writeBufferJSON(file, buffer) {
        const filePath = path.join(this.mqttDataPath, file);
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
            .then(() => {
            this.log.debug(`Successfully wrote to ${filePath}.json`);
            return;
        })
            .catch((error) => {
            this.log.error(`Error writing to ${filePath}.json:`, error);
        });
    }
    writeFile(file, data) {
        const filePath = path.join(this.mqttDataPath, file);
        fs.promises
            .writeFile(filePath, data)
            .then(() => {
            this.log.debug(`Successfully wrote to ${filePath}`);
            return;
        })
            .catch((error) => {
            this.log.error(`Error writing to ${filePath}:`, error);
        });
    }
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
            if (this.log.logLevel === "debug")
                this.writeBufferJSON('bridge-info', payload);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/devices')) {
            if (this.log.logLevel === "debug")
                this.writeBufferJSON('bridge-devices', payload);
            this.z2mDevices = this.tryJsonParse(payload.toString());
            this.emit('bridge-devices', this.z2mDevices);
        }
        else if (topic.startsWith(this.mqttTopic + '/bridge/groups')) {
            if (this.log.logLevel === "debug")
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
            if (this.log.logLevel === "debug" && this.loggedBridgePayloads < 10000) {
                const logEntry = {
                    entity,
                    service,
                    payload: payload.toString(),
                };
                const filePath = path.join(this.mqttDataPath, 'bridge-payloads.txt');
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
        if (!payload || payload.length === 0) {
            return;
        }
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
        if (!payload || payload.length === 0) {
            return;
        }
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
            if (lqi < 50) {
                return `\x1b[31m${lqi.toString().padStart(3, ' ')}${db}`;
            }
            else if (lqi > 200) {
                return `\x1b[32m${lqi.toString().padStart(3, ' ')}${db}`;
            }
            else {
                return `\x1b[38;5;251m${lqi.toString().padStart(3, ' ')}${db}`;
            }
        };
        const depth = (depth) => {
            if (depth === 255) {
                return `\x1b[32m${depth.toString().padStart(3, ' ')}${db}`;
            }
            else {
                return `\x1b[38;5;251m${depth.toString().padStart(3, ' ')}${db}`;
            }
        };
        const relationship = (relationship) => {
            if (relationship === 0) {
                return `${zb}${relationship}-IsParent  ${db}`;
            }
            else if (relationship === 1) {
                return `${hk}${relationship}-IsAChild  ${db}`;
            }
            else {
                return `${relationship}-IsASibling`;
            }
        };
        const friendlyName = (ieeeAddr) => {
            const node = topology.nodes.find((node) => node.ieeeAddr === ieeeAddr);
            if (node) {
                if (node.type === 'Coordinator') {
                    return `\x1b[48;5;1m\x1b[38;5;255m${node.friendlyName} [C]${rs}${db}`;
                }
                else if (node.type === 'Router') {
                    return `${dn}${node.friendlyName} [R]${db}`;
                }
                else if (node.type === 'EndDevice') {
                    return `${gn}${node.friendlyName} [E]${db}`;
                }
            }
            return `${er}${ieeeAddr}${db}`;
        };
        const timePassedSince = (lastSeen) => {
            const now = Date.now();
            const difference = now - lastSeen;
            const days = Math.floor(difference / (1000 * 60 * 60 * 24));
            if (days > 0) {
                return `${days} days ago`;
            }
            const hours = Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            if (hours > 0) {
                return `${hours} hours ago`;
            }
            const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
            if (minutes > 0) {
                return `${minutes} minutes ago`;
            }
            const seconds = Math.floor((difference % (1000 * 60)) / 1000);
            return `${seconds} seconds ago`;
        };
        if (this.log.logLevel === "debug")
            this.writeBufferJSON('networkmap_' + data.data.type, payload);
        if (data.data.type === 'graphviz') {
            if (this.log.logLevel === "debug")
                this.writeFile('networkmap_' + data.data.type + '.txt', data.data.value);
        }
        if (data.data.type === 'plantuml') {
            if (this.log.logLevel === "debug")
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
