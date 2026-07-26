import path from 'node:path';
import { MatterbridgeDynamicPlatform } from 'matterbridge';
import { CYAN, db, debugStringify, dn, er, gn, nf, payloadStringify, rs, wr, zb } from 'matterbridge/logger';
import { BridgedDeviceBasicInformation, DoorLock } from 'matterbridge/matter/clusters';
import { fireAndForget, getErrorMessage, isValidNumber, isValidString, waiter } from 'matterbridge/utils';
import { ZigbeeDevice, ZigbeeGroup } from './entity.js';
import { Zigbee2MQTT } from './zigbee2mqtt.js';
export default function initializePlugin(matterbridge, log, config) {
    return new ZigbeePlatform(matterbridge, log, config);
}
export class ZigbeePlatform extends MatterbridgeDynamicPlatform {
    config;
    bridgedDevices = [];
    zigbeeEntities = [];
    connectTimeout = 90000;
    availabilityTimeout = 10000;
    injectTimer;
    mqttHost = 'mqtt://localhost';
    mqttPort = 1883;
    mqttTopic = 'zigbee2mqtt';
    mqttUsername = undefined;
    mqttPassword = undefined;
    lightList = [];
    outletList = [];
    switchList = [];
    featureBlackList = [];
    deviceFeatureBlackList = {};
    postfix = '';
    shouldStart;
    shouldConfigure;
    z2m;
    z2mDevicesRegistered = false;
    z2mGroupsRegistered = false;
    z2mBridgeOnline;
    z2mBridgeInfo;
    z2mBridgeDevices;
    z2mBridgeGroups;
    z2mEntityAvailability = new Map();
    z2mEntityPayload = new Map();
    availabilityTimer;
    constructor(matterbridge, log, config) {
        super(matterbridge, log, config);
        this.config = config;
        if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.9.0')) {
            throw new Error(`This plugin requires Matterbridge version >= "3.9.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`);
        }
        this.shouldStart = false;
        this.shouldConfigure = false;
        if (config.host && typeof config.host === 'string') {
            this.mqttHost = config.host;
            this.mqttHost =
                !this.mqttHost.startsWith('mqtt://') &&
                    !this.mqttHost.startsWith('mqtts://') &&
                    !this.mqttHost.startsWith('ws://') &&
                    !this.mqttHost.startsWith('wss://') &&
                    !this.mqttHost.startsWith('mqtt+unix://')
                    ? 'mqtt://' + this.mqttHost
                    : this.mqttHost;
        }
        if (config.port)
            this.mqttPort = config.port;
        if (config.topic)
            this.mqttTopic = config.topic;
        if (config.username)
            this.mqttUsername = config.username;
        if (config.password)
            this.mqttPassword = config.password;
        if (!isValidNumber(config.protocolVersion, 3, 5))
            config.protocolVersion = 5;
        if (config.switchList)
            this.switchList = config.switchList;
        if (config.lightList)
            this.lightList = config.lightList;
        if (config.outletList)
            this.outletList = config.outletList;
        if (config.featureBlackList)
            this.featureBlackList = config.featureBlackList;
        if (config.deviceFeatureBlackList)
            this.deviceFeatureBlackList = config.deviceFeatureBlackList;
        if (config.postfix && typeof config.postfix === 'string') {
            this.postfix = config.postfix;
        }
        this.postfix = this.postfix.trim().slice(0, 3);
        this.config.debug ??= false;
        this.config.unregisterOnShutdown ??= false;
        config.host = this.mqttHost;
        config.port = this.mqttPort;
        config.topic = this.mqttTopic;
        config.username = this.mqttUsername ?? '';
        config.password = this.mqttPassword ?? '';
        config.postfix = this.postfix;
        if (config.postfixHostname !== undefined)
            delete config.postfixHostname;
        if (config.deviceScenes !== undefined)
            delete config.deviceScenes;
        if (config.groupScenes !== undefined)
            delete config.groupScenes;
        config.scenesType ??= 'outlet';
        config.scenesPrefix ??= true;
        this.log.info(`Initializing platform: ${CYAN}${this.config.name}${nf} version: ${CYAN}${this.config.version}${rs}`);
        this.log.info(`Loaded zigbee2mqtt parameters from ${CYAN}${path.join(matterbridge.matterbridgeDirectory, 'matterbridge-zigbee2mqtt.config.json')}${rs}`);
        this.z2m = new Zigbee2MQTT(this.mqttHost, this.mqttPort, this.mqttTopic, this.mqttUsername, this.mqttPassword, this.config.clientId, this.config.protocolVersion, this.config.ca, this.config.rejectUnauthorized, this.config.cert, this.config.key, config.debug);
        this.z2m.setLogDebug(config.debug);
        this.z2m.setDataPath(path.join(matterbridge.matterbridgePluginDirectory, 'matterbridge-zigbee2mqtt'));
        if (isValidString(this.mqttHost) && isValidNumber(this.mqttPort, 1, 65535)) {
            this.log.info(`Connecting to MQTT broker: ${this.z2m.getUrl()}`);
            this.z2m.start();
        }
        else {
            this.log.error(`Invalid MQTT broker host: ${this.mqttHost} or port: ${this.mqttPort}`);
        }
        this.z2m.on('mqtt_connect', () => {
            this.log.info(`MQTT broker at ${this.z2m.getUrl()} connected`);
            this.z2m.subscribe(this.z2m.mqttTopic + '/#');
        });
        this.z2m.on('mqtt_subscribed', () => {
            this.log.info(`MQTT broker at ${this.z2m.getUrl()} subscribed to: ${this.z2m.mqttTopic + '/#'}`);
        });
        this.z2m.on('close', () => {
            this.log.warn(`MQTT broker at ${this.z2m.getUrl()} closed the connection`);
        });
        this.z2m.on('end', () => {
            this.log.warn(`MQTT broker at ${this.z2m.getUrl()} ended the connection`);
        });
        this.z2m.on('mqtt_error', (error) => {
            this.log.error(`MQTT broker at ${this.z2m.getUrl()} error:`, error);
        });
        this.z2m.on('online', () => {
            this.log.info('zigbee2MQTT is online');
            this.z2mBridgeOnline = true;
            fireAndForget(this.updateAvailability(true), this.log, `Failed to update availability on zigbee2MQTT online event`);
        });
        this.z2m.on('offline', () => {
            this.log.warn('zigbee2MQTT is offline');
            this.z2mBridgeOnline = false;
            fireAndForget(this.updateAvailability(false), this.log, `Failed to update availability on zigbee2MQTT offline event`);
        });
        this.z2m.on('bridge-info', (bridgeInfo) => {
            if (bridgeInfo === null || bridgeInfo === undefined)
                return;
            this.z2mBridgeInfo = bridgeInfo;
            this.log.info(`zigbee2MQTT version ${this.z2mBridgeInfo.version} zh version ${this.z2mBridgeInfo.zigbee_herdsman.version} zhc version ${this.z2mBridgeInfo.zigbee_herdsman_converters.version}`);
            if (this.z2mBridgeInfo.config.advanced.output === 'attribute')
                this.log.error(`zigbee2MQTT advanced.output must be 'json' or 'attribute_and_json'. Now is ${this.z2mBridgeInfo.config.advanced.output}`);
            if (this.z2mBridgeInfo.config.advanced.legacy_api)
                this.log.info(`zigbee2MQTT advanced.legacy_api is ${this.z2mBridgeInfo.config.advanced.legacy_api}`);
            if (this.z2mBridgeInfo.config.advanced.legacy_availability_payload)
                this.log.info(`zigbee2MQTT advanced.legacy_availability_payload is ${this.z2mBridgeInfo.config.advanced.legacy_availability_payload}`);
            if (this.z2mBridgeInfo.config.frontend?.package)
                this.log.info(`zigbee2MQTT frontend.package is ${this.z2mBridgeInfo.config.frontend?.package}`);
        });
        this.z2m.on('bridge-devices', (devices) => {
            fireAndForget((async () => {
                if (devices === null || devices === undefined)
                    return;
                this.log.info(`zigbee2MQTT sent ${devices.length} devices ${this.z2mDevicesRegistered ? 'already registered' : ''}`);
                this.z2mBridgeDevices = devices;
                if (this.shouldStart) {
                    if (!this.z2mDevicesRegistered && this.z2mBridgeDevices) {
                        for (const device of this.z2mBridgeDevices) {
                            await this.registerZigbeeDevice(device);
                        }
                        this.z2mDevicesRegistered = true;
                    }
                }
                if (this.shouldConfigure) {
                    this.log.info(`Configuring ${this.zigbeeEntities.length} zigbee entities.`);
                    for (const bridgedEntity of this.zigbeeEntities) {
                        if (bridgedEntity.isDevice && bridgedEntity.device)
                            this.requestDeviceUpdate(bridgedEntity.device);
                        await bridgedEntity.configure();
                    }
                }
            })(), this.log, 'Failed to process bridge-devices event');
        });
        this.z2m.on('bridge-groups', (groups) => {
            fireAndForget((async () => {
                if (groups === null || groups === undefined)
                    return;
                this.log.info(`zigbee2MQTT sent ${groups.length} groups ${this.z2mGroupsRegistered ? 'already registered' : ''}`);
                this.z2mBridgeGroups = groups;
                if (this.shouldStart) {
                    if (!this.z2mGroupsRegistered && this.z2mBridgeGroups) {
                        for (const group of this.z2mBridgeGroups) {
                            await this.registerZigbeeGroup(group);
                        }
                        this.z2mGroupsRegistered = true;
                    }
                }
                if (this.shouldConfigure) {
                    this.log.info(`Configuring ${this.zigbeeEntities.length} zigbee entities.`);
                    for (const bridgedEntity of this.zigbeeEntities) {
                        if (bridgedEntity.isGroup && bridgedEntity.group)
                            this.requestGroupUpdate(bridgedEntity.group);
                        await bridgedEntity.configure();
                    }
                }
            })(), this.log, 'Failed to process bridge-groups event');
        });
        this.z2m.on('availability', (device, available) => {
            this.z2mEntityAvailability.set(device, available);
            if (available)
                this.log.info(`zigbee2MQTT entity ${device} is ${available ? 'online' : 'offline'}`);
            else
                this.log.warn(`zigbee2MQTT entity ${device} is ${available ? 'online' : 'offline'}`);
        });
        this.z2m.on('message', (device, payload) => {
            this.z2mEntityPayload.set(device, payload);
        });
        this.z2m.on('permit_join', (device, time, status) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent permit_join device: ${device} time: ${time} status: ${status}`);
                for (const zigbeeEntity of this.zigbeeEntities) {
                    if (zigbeeEntity.isRouter && (device === undefined || device === zigbeeEntity.bridgedDevice?.deviceName)) {
                        this.log.info(`*- ${zigbeeEntity.bridgedDevice?.deviceName} ${zigbeeEntity.bridgedDevice?.number} (${zigbeeEntity.bridgedDevice?.name})`);
                        if (zigbeeEntity.device && status) {
                            await zigbeeEntity.bridgedDevice?.setAttribute(DoorLock, 'lockState', DoorLock.LockState.Unlocked, this.log);
                            await zigbeeEntity.bridgedDevice?.triggerEvent(DoorLock, 'lockOperation', { lockOperationType: DoorLock.LockOperationType.Unlock, operationSource: DoorLock.OperationSource.Manual, userIndex: null, fabricIndex: null, sourceNode: null }, this.log);
                            this.log.info(`Device ${zigbeeEntity.entityName} unlocked`);
                        }
                        if (zigbeeEntity.device && !status) {
                            await zigbeeEntity.bridgedDevice?.setAttribute(DoorLock, 'lockState', DoorLock.LockState.Locked, this.log);
                            await zigbeeEntity.bridgedDevice?.triggerEvent(DoorLock, 'lockOperation', { lockOperationType: DoorLock.LockOperationType.Lock, operationSource: DoorLock.OperationSource.Manual, userIndex: null, fabricIndex: null, sourceNode: null }, this.log);
                            this.log.info(`Device ${zigbeeEntity.entityName} locked`);
                        }
                    }
                }
            })(), this.log, 'Failed to process permit_join event');
        });
        this.z2m.on('device_joined', (friendly_name, ieee_address) => {
            this.log.info(`zigbee2MQTT sent device_joined device: ${friendly_name} ieee_address: ${ieee_address}`);
        });
        this.z2m.on('device_announce', (friendly_name, ieee_address) => {
            this.log.info(`zigbee2MQTT sent device_announce device: ${friendly_name} ieee_address: ${ieee_address}`);
        });
        this.z2m.on('device_leave', (friendly_name, ieee_address) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent device_leave device: ${friendly_name} ieee_address: ${ieee_address}`);
                await this.unregisterZigbeeEntity(friendly_name);
            })(), this.log, `Failed to unregister device ${friendly_name} on device_leave event`);
        });
        this.z2m.on('device_remove', (friendly_name, status, block, force) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent device_remove device: ${friendly_name} status: ${status} block: ${block} force: ${force}`);
                if (status === 'ok')
                    await this.unregisterZigbeeEntity(friendly_name);
            })(), this.log, `Failed to unregister device ${friendly_name} on device_remove event`);
        });
        this.z2m.on('device_interview', (friendly_name, ieee_address, status, supported) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent device_interview device: ${friendly_name} ieee_address: ${ieee_address} status: ${status} supported: ${supported}`);
                if (status === 'successful' && supported) {
                    if (!this.validateDevice(friendly_name))
                        return;
                    this.log.info(`Registering device: ${friendly_name}`);
                    const bridgedDevice = this.z2mBridgeDevices?.find((device) => device.friendly_name === friendly_name);
                    if (bridgedDevice)
                        await this.registerZigbeeDevice(bridgedDevice);
                }
            })(), this.log, `Failed to register device ${friendly_name} on device_interview event`);
        });
        this.z2m.on('device_rename', (ieee_address, from, to) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent device_rename ieee_address: ${ieee_address} from: ${from} to: ${to}`);
                await this.unregisterZigbeeEntity(from);
                const bridgedDevice = this.z2mBridgeDevices?.find((device) => device.ieee_address === ieee_address);
                if (bridgedDevice)
                    await this.registerZigbeeDevice(bridgedDevice);
            })(), this.log, `Failed to rename device from ${from} to ${to} on device_rename event`);
        });
        this.z2m.on('device_options', (ieee_address, status, from, to) => {
            this.log.info(`zigbee2MQTT sent device_options ieee_address: ${ieee_address} status ${status} from: ${debugStringify(from)} to: ${debugStringify(to)}`);
        });
        this.z2m.on('group_add', (friendly_name, id, status) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent group_add friendly_name: ${friendly_name} id ${id} status ${status}`);
                if (!this.validateDevice(friendly_name))
                    return;
                this.log.info(`Registering group: ${friendly_name}`);
                const bridgedGroup = this.z2mBridgeGroups?.find((group) => group.friendly_name === friendly_name);
                if (bridgedGroup)
                    await this.registerZigbeeGroup(bridgedGroup);
            })(), this.log, `Failed to register group ${friendly_name} on group_add event`);
        });
        this.z2m.on('group_remove', (friendly_name, status) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent group_remove friendly_name: ${friendly_name} status ${status}`);
                if (status === 'ok')
                    await this.unregisterZigbeeEntity(friendly_name);
            })(), this.log, `Failed to unregister group ${friendly_name} on group_remove event`);
        });
        this.z2m.on('group_rename', (from, to, status) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent group_rename from: ${from} to ${to} status ${status}`);
                if (status === 'ok') {
                    await this.unregisterZigbeeEntity(from);
                    const bridgedGroup = this.z2mBridgeGroups?.find((group) => group.friendly_name === to);
                    if (bridgedGroup)
                        await this.registerZigbeeGroup(bridgedGroup);
                }
            })(), this.log, `Failed to rename group from ${from} to ${to} on group_rename event`);
        });
        this.z2m.on('group_add_member', (group_friendly_name, device_ieee_address, status) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent group_add_member group ${group_friendly_name} add device ieee_address ${device_ieee_address} status ${status}`);
                if (status === 'ok') {
                    await this.unregisterZigbeeEntity(group_friendly_name);
                    const bridgedGroup = this.z2mBridgeGroups?.find((group) => group.friendly_name === group_friendly_name);
                    if (bridgedGroup)
                        await this.registerZigbeeGroup(bridgedGroup);
                }
            })(), this.log, `Failed to add member to group ${group_friendly_name} on group_add_member event`);
        });
        this.z2m.on('group_remove_member', (group_friendly_name, device_friendly_name, status) => {
            fireAndForget((async () => {
                this.log.info(`zigbee2MQTT sent group_remove_member group ${group_friendly_name} remove device friendly_name ${device_friendly_name} status ${status}`);
                if (status === 'ok') {
                    await this.unregisterZigbeeEntity(group_friendly_name);
                    const bridgedGroup = this.z2mBridgeGroups?.find((group) => group.friendly_name === group_friendly_name);
                    if (bridgedGroup)
                        await this.registerZigbeeGroup(bridgedGroup);
                }
            })(), this.log, `Failed to remove member from group ${group_friendly_name} on group_remove_member event`);
        });
        this.log.debug('Created zigbee2mqtt dynamic platform');
    }
    async onStart(reason) {
        this.log.info(`Starting zigbee2mqtt dynamic platform v${this.version}: ` + reason);
        await this.ready;
        await this.clearSelect();
        this.setSelectEntity('scenes', 'Scenes', 'component');
        await waiter('zigbee2mqtt', () => this.z2mBridgeDevices !== undefined && this.z2mBridgeGroups !== undefined && (this.z2mBridgeOnline !== undefined || this.z2mBridgeInfo !== undefined), false, this.connectTimeout, 1000, true);
        if (this.z2mBridgeOnline === undefined)
            this.log.error('The plugin did not receive zigbee2mqtt bridge state. Check if zigbee2mqtt is running and connected to the MQTT broker.');
        if (this.z2mBridgeInfo === undefined)
            this.log.error('The plugin did not receive zigbee2mqtt bridge info. Check if zigbee2mqtt is running and connected to the MQTT broker.');
        if (this.z2mBridgeDevices === undefined && this.z2mBridgeGroups === undefined)
            this.log.error('The plugin did not receive zigbee2mqtt bridge devices/groups. Check if zigbee2mqtt is running and connected to the MQTT broker.');
        if (this.z2mBridgeOnline === undefined || this.z2mBridgeInfo === undefined || (this.z2mBridgeDevices === undefined && this.z2mBridgeGroups === undefined)) {
            throw new Error('The plugin did not receive zigbee2mqtt bridge state or info or devices/groups. Check if zigbee2mqtt is running and connected to the MQTT broker.');
        }
        if (!this.z2mDevicesRegistered && this.z2mBridgeDevices) {
            this.log.info(`Registering ${this.z2mBridgeDevices.length} devices`);
            for (const device of this.z2mBridgeDevices) {
                await this.registerZigbeeDevice(device);
            }
            this.z2mDevicesRegistered = true;
        }
        if (!this.z2mGroupsRegistered && this.z2mBridgeGroups) {
            this.log.info(`Registering ${this.z2mBridgeGroups.length} groups`);
            for (const group of this.z2mBridgeGroups) {
                await this.registerZigbeeGroup(group);
            }
            this.z2mGroupsRegistered = true;
        }
        this.log.info(`Started zigbee2mqtt dynamic platform v${this.version}: ` + reason);
    }
    async onConfigure() {
        await super.onConfigure();
        this.log.info(`Configuring ${this.zigbeeEntities.length} zigbee entities.`);
        for (const bridgedEntity of this.zigbeeEntities) {
            await bridgedEntity.configure();
            if (bridgedEntity.isRouter && bridgedEntity.bridgedDevice) {
                this.log.info(`Configuring router ${bridgedEntity.bridgedDevice.deviceName}.`);
                if (this.z2mBridgeInfo?.permit_join) {
                    await bridgedEntity.bridgedDevice.setAttribute(DoorLock, 'lockState', DoorLock.LockState.Unlocked, this.log);
                    if (bridgedEntity.bridgedDevice.maybeNumber)
                        await bridgedEntity.bridgedDevice.triggerEvent(DoorLock, 'lockOperation', { lockOperationType: DoorLock.LockOperationType.Unlock, operationSource: DoorLock.OperationSource.Manual, userIndex: null, fabricIndex: null, sourceNode: null }, this.log);
                }
                else {
                    await bridgedEntity.bridgedDevice.setAttribute(DoorLock, 'lockState', DoorLock.LockState.Locked, this.log);
                    if (bridgedEntity.bridgedDevice.maybeNumber)
                        await bridgedEntity.bridgedDevice.triggerEvent(DoorLock, 'lockOperation', { lockOperationType: DoorLock.LockOperationType.Lock, operationSource: DoorLock.OperationSource.Manual, userIndex: null, fabricIndex: null, sourceNode: null }, this.log);
                }
            }
            if (bridgedEntity.isDevice && bridgedEntity.device)
                this.requestDeviceUpdate(bridgedEntity.device);
            if (bridgedEntity.isGroup && bridgedEntity.group)
                this.requestGroupUpdate(bridgedEntity.group);
        }
        this.availabilityTimer = setTimeout(() => {
            this.log.info(`Setting availability for ${this.z2mEntityAvailability.size} entities`);
            for (const [entity, available] of this.z2mEntityAvailability) {
                if (available)
                    this.z2m.emit('ONLINE-' + entity);
                else
                    this.z2m.emit('OFFLINE-' + entity);
            }
            this.log.info(`Setting retained values for ${this.z2mEntityPayload.size} entities`);
            for (const [entity, payload] of this.z2mEntityPayload) {
                this.z2m.emit('MESSAGE-' + entity, payload);
            }
        }, this.availabilityTimeout).unref();
        this.log.info(`Configured zigbee2mqtt dynamic platform v${this.version}`);
    }
    async onChangeLoggerLevel(logLevel) {
        this.log.info(`Configuring zigbee2mqtt platform logger level to ${CYAN}${logLevel}${nf}`);
        this.log.logLevel = logLevel;
        this.z2m.setLogLevel(logLevel);
        for (const bridgedDevice of this.bridgedDevices) {
            bridgedDevice.log.logLevel = logLevel;
        }
        for (const entity of this.zigbeeEntities) {
            entity.log.logLevel = logLevel;
        }
        this.log.debug('Changed logger level to ' + logLevel);
    }
    async onShutdown(reason) {
        await super.onShutdown(reason);
        this.z2m.removeAllListeners();
        this.z2m.stop();
        this.log.debug('Shutting down zigbee2mqtt platform: ' + reason);
        for (const entity of this.zigbeeEntities) {
            entity.destroy();
        }
        if (this.injectTimer)
            clearInterval(this.injectTimer);
        this.injectTimer = undefined;
        if (this.availabilityTimer)
            clearInterval(this.availabilityTimer);
        this.availabilityTimer = undefined;
        if (this.config.unregisterOnShutdown)
            await this.unregisterAllDevices();
        this.bridgedDevices = [];
        this.zigbeeEntities = [];
        this.z2mBridgeDevices = undefined;
        this.z2mBridgeGroups = undefined;
        this.z2mBridgeInfo = undefined;
        this.z2mEntityAvailability.clear();
        this.z2mEntityPayload.clear();
        this.log.info(`Shutdown zigbee2mqtt dynamic platform v${this.version}`);
    }
    publish(topic, subTopic, message) {
        this.log.info(`MQTT publish topic: ${CYAN}${this.z2m.mqttTopic + '/' + topic + (subTopic === '' ? '' : '/' + subTopic)}${nf} payload: ${CYAN}${message}${nf}`);
        this.z2m.publish(this.z2m.mqttTopic + '/' + topic + (subTopic === '' ? '' : '/' + subTopic), message);
    }
    requestDeviceUpdate(device) {
        this.log.debug(`Requesting update for ${device.friendly_name} model_id: ${device.model_id} manufacturer: ${device.manufacturer}`);
        const payload = {};
        if (device.power_source === 'Battery' || !device.definition?.exposes)
            return;
        for (const feature of device.definition.exposes) {
            if (feature.features) {
                for (const subFeature of feature.features) {
                    if (subFeature.access & 0b100) {
                        payload[subFeature.property] = '';
                    }
                }
            }
            if (feature.access & 0b100) {
                payload[feature.property] = '';
            }
        }
        if (payload && Object.keys(payload).length > 0) {
            const topic = this.z2m.mqttTopic + '/' + device.friendly_name + '/get';
            this.z2m.publish(topic, payloadStringify(payload), false);
        }
    }
    requestGroupUpdate(group) {
        this.log.debug(`Requesting update for ${group.friendly_name}`);
        const payload = {};
        payload['state'] = '';
        if (payload && Object.keys(payload).length > 0) {
            const topic = this.z2m.mqttTopic + '/' + group.friendly_name + '/get';
            this.z2m.publish(topic, payloadStringify(payload), false);
        }
    }
    async registerZigbeeDevice(device) {
        this.setSelectDevice(device.ieee_address, device.friendly_name, undefined, 'wifi');
        if (!this.validateDevice([device.friendly_name, device.ieee_address], true)) {
            return undefined;
        }
        this.log.debug(`Registering device ${dn}${device.friendly_name}${db} ID: ${zb}${device.ieee_address}${db}`);
        let matterDevice;
        try {
            matterDevice = await ZigbeeDevice.create(this, device);
            if (matterDevice.bridgedDevice) {
                matterDevice.bridgedDevice.configUrl = `${this.config.zigbeeFrontend}/#/device/${this.z2mBridgeInfo?.config.frontend?.package === 'zigbee2mqtt-frontend' ? '' : '0/'}${device.ieee_address}/info`;
                await this.registerDevice(matterDevice.bridgedDevice);
                this.bridgedDevices.push(matterDevice.bridgedDevice);
                this.zigbeeEntities.push(matterDevice);
                this.log.debug(`Registered device ${dn}${device.friendly_name}${db} ID: ${zb}${device.ieee_address}${db}`);
            }
            else
                this.log.warn(`Device ${dn}${device.friendly_name}${wr} ID: ${device.ieee_address} not registered`);
        }
        catch (error) {
            this.log.error(`Error registering device ${dn}${device.friendly_name}${er} ID: ${device.ieee_address}: ${getErrorMessage(error)}`);
        }
        return matterDevice;
    }
    async registerZigbeeGroup(group) {
        this.setSelectDevice(`group-${group.id}`, group.friendly_name, undefined, 'wifi');
        if (!this.validateDevice([group.friendly_name, `group-${group.id}`], true)) {
            return undefined;
        }
        this.log.debug(`Registering group ${gn}${group.friendly_name}${db} ID: ${zb}${group.id}${db}`);
        let matterGroup;
        try {
            matterGroup = await ZigbeeGroup.create(this, group);
            if (matterGroup.bridgedDevice) {
                matterGroup.bridgedDevice.configUrl = `${this.config.zigbeeFrontend}/#/group/${this.z2mBridgeInfo?.config.frontend?.package === 'zigbee2mqtt-frontend' ? '' : '0/'}${group.id}`;
                await this.registerDevice(matterGroup.bridgedDevice);
                this.bridgedDevices.push(matterGroup.bridgedDevice);
                this.zigbeeEntities.push(matterGroup);
                this.log.debug(`Registered group ${gn}${group.friendly_name}${db} ID: ${zb}${group.id}${db}`);
            }
            else
                this.log.warn(`Group ${gn}${group.friendly_name}${wr} ID: ${group.id} not registered`);
        }
        catch (error) {
            this.log.error(`Error registering group ${gn}${group.friendly_name}${er} ID: ${group.id}: ${getErrorMessage(error)}`);
        }
        return matterGroup;
    }
    async unregisterZigbeeEntity(friendly_name) {
        const entity = this.zigbeeEntities.find((entity) => entity.entityName === friendly_name);
        if (entity?.bridgedDevice) {
            this.log.info(`Removing device: ${friendly_name}`);
            await this.unregisterDevice(entity.bridgedDevice);
            entity.destroy();
            this.zigbeeEntities = this.zigbeeEntities.filter((entity) => entity.entityName !== friendly_name);
            this.bridgedDevices = this.bridgedDevices.filter((device) => device.deviceName !== friendly_name);
        }
    }
    async updateAvailability(available) {
        if (this.bridgedDevices.length === 0)
            return;
        this.log.info(`Setting availability for ${this.bridgedDevices.length} devices to ${available}`);
        for (const bridgedDevice of this.bridgedDevices) {
            await bridgedDevice.setAttribute(BridgedDeviceBasicInformation, 'reachable', available, this.log);
            if (bridgedDevice.maybeNumber)
                await bridgedDevice.triggerEvent(BridgedDeviceBasicInformation, 'reachableChanged', { reachableNewValue: available }, this.log);
        }
    }
}
