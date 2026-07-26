/**
 * @file src/module.ts
 * @description This file contains the class ZigbeePlatform.
 * @author Luca Liguori
 * @created 2023-12-29
 * @version 3.1.0
 * @license Apache-2.0
 *
 * Copyright 2023, 2024, 2025, 2026, 2027 Luca Liguori.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { type BasePlatformConfig, MatterbridgeDynamicPlatform, type MatterbridgeEndpoint, type PlatformMatterbridge } from 'matterbridge';
import { type AnsiLogger, type LogLevel } from 'matterbridge/logger';
import { type ZigbeeEntity, ZigbeeGroup } from './entity.js';
import { Zigbee2MQTT, Zigbee2MQTTWs } from './zigbee2mqtt.js';
import type { BridgeDevice, BridgeGroup, BridgeInfo } from './zigbee2mqttTypes.js';
type TransportMode = 'mqtt' | 'websocket';
type DeviceFeatureBlackList = Record<string, string[]>;
export type ZigbeePlatformConfig = BasePlatformConfig & {
    transport: TransportMode;
    host: string;
    port: number;
    mqttHost: string;
    mqttPort: number;
    mqttUsername: string;
    mqttPassword: string;
    protocolVersion: 3 | 4 | 5;
    username: string;
    password: string;
    clientId: string;
    ca: string;
    rejectUnauthorized: boolean;
    cert: string;
    key: string;
    topic: string;
    token: string;
    zigbeeFrontend: string;
    whiteList: string[];
    blackList: string[];
    switchList: string[];
    lightList: string[];
    outletList: string[];
    featureBlackList: string[];
    deviceFeatureBlackList: DeviceFeatureBlackList;
    scenesType: 'light' | 'outlet' | 'switch' | 'mounted_switch';
    scenesPrefix: boolean;
    postfix: string;
};
/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 * Each plugin should return the platform.
 *
 * Initializes the Zigbee2mqtt plugin.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {ZigbeePlatformConfig} config - The platform configuration.
 * @returns {ZigbeePlatform} The initialized Zigbee platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: ZigbeePlatformConfig): ZigbeePlatform;
export declare class ZigbeePlatform extends MatterbridgeDynamicPlatform {
    config: ZigbeePlatformConfig;
    bridgedDevices: MatterbridgeEndpoint[];
    zigbeeEntities: ZigbeeEntity[];
    private connectTimeout;
    private availabilityTimeout;
    private injectTimer;
    private transport;
    private wsHost;
    private wsPort;
    private wsToken;
    private mqttHost;
    private mqttPort;
    private mqttTopic;
    private mqttUsername;
    private mqttPassword;
    lightList: string[];
    outletList: string[];
    switchList: string[];
    featureBlackList: string[];
    deviceFeatureBlackList: DeviceFeatureBlackList;
    postfix: string;
    shouldStart: boolean;
    shouldConfigure: boolean;
    z2m: Zigbee2MQTT | Zigbee2MQTTWs;
    z2mDevicesRegistered: boolean;
    z2mGroupsRegistered: boolean;
    z2mBridgeOnline: boolean | undefined;
    z2mBridgeInfo: BridgeInfo | undefined;
    z2mBridgeDevices: BridgeDevice[] | undefined;
    z2mBridgeGroups: BridgeGroup[] | undefined;
    private z2mEntityAvailability;
    private z2mEntityPayload;
    private availabilityTimer;
    constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: ZigbeePlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onChangeLoggerLevel(logLevel: LogLevel): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
    publish(topic: string, subTopic: string, message: string): void;
    private requestDeviceUpdate;
    private requestGroupUpdate;
    private registerZigbeeDevice;
    registerZigbeeGroup(group: BridgeGroup): Promise<ZigbeeGroup | undefined>;
    private unregisterZigbeeEntity;
    private updateAvailability;
}
export {};
//# sourceMappingURL=module.d.ts.map