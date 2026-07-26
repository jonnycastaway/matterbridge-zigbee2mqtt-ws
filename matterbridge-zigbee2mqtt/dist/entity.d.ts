/**
 * @file src/entity.ts
 * @description This file contains the classes ZigbeeEntity, ZigbeeDevice and ZigbeeGroup.
 * @author Luca Liguori
 * @created 2023-12-29
 * @version 3.4.0
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
import EventEmitter from 'node:events';
import { type CommandHandlerData, type CommandHandlerDataMap, type DeviceTypeDefinition, MatterbridgeEndpoint } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { ClusterId, type Semtag } from 'matterbridge/matter/types';
import type { ZigbeePlatform } from './module.js';
import type { Payload, PayloadValue } from './payloadTypes.js';
import type { BridgeDevice, BridgeGroup } from './zigbee2mqttTypes.js';
interface BehaviorOptions {
    clusterId: ClusterId;
    options: Record<string, boolean | number | bigint | string | object | null>;
}
/**
 * Represents a Zigbee entity: a group or a device.
 *
 * @class
 * @augments {EventEmitter}
 */
export declare class ZigbeeEntity extends EventEmitter {
    log: AnsiLogger;
    serial: string;
    protected platform: ZigbeePlatform;
    device: BridgeDevice | undefined;
    group: BridgeGroup | undefined;
    entityName: string;
    isDevice: boolean;
    isGroup: boolean;
    actions: string[];
    protected en: string;
    protected ien: string;
    bridgedDevice: MatterbridgeEndpoint | undefined;
    eidn: string;
    protected lastPayload: Payload;
    private lastSeen;
    protected ignoreFeatures: string[];
    protected transition: boolean;
    protected propertyMap: Map<string, {
        name: string;
        type: string;
        endpoint: string;
        values?: string;
        value_min?: number;
        value_max?: number;
        unit?: string;
        category?: string;
        description?: string;
        label?: string;
        action?: string;
    }>;
    protected readonly mutableDevice: Map<string, {
        tagList: Semtag[];
        deviceTypes: DeviceTypeDefinition[];
        clusterServersIds: ClusterId[];
        clusterServersOptions: BehaviorOptions[];
        clusterClientsIds: ClusterId[];
        clusterClientsOptions: BehaviorOptions[];
    }>;
    protected cachePayload: Payload;
    protected cachePublishTimeout: NodeJS.Timeout | undefined;
    protected cachePublishTimeoutTime: number;
    protected noUpdateTimeout: NodeJS.Timeout | undefined;
    protected noUpdateTimeoutTime: number;
    protected thermostatTimeout: NodeJS.Timeout | undefined;
    protected thermostatTimeoutTime: number;
    protected composedType: string;
    protected hasEndpoints: boolean;
    isRouter: boolean;
    protected noUpdate: boolean;
    protected readonly thermostatSystemModeLookup: string[];
    /**
     * Creates an instance of ZigbeeEntity.
     *
     * @param {ZigbeePlatform} platform - The Zigbee platform instance.
     * @param {BridgeDevice | BridgeGroup} entity - The bridge device or group instance received from zigbee2mqtt.
     */
    constructor(platform: ZigbeePlatform, entity: BridgeDevice | BridgeGroup);
    /**
     * Destroys the ZigbeeEntity instance by clearing any active timeouts.
     *
     * @remarks
     * This method is used to clean up the ZigbeeEntity instance by clearing any active timeouts for color and thermostat operations.
     * It ensures that no further actions are taken on these timeouts after the entity is destroyed.
     */
    destroy(): void;
    isValidDevice(entity: BridgeDevice | BridgeGroup): entity is BridgeDevice;
    isValidGroup(entity: BridgeDevice | BridgeGroup): entity is BridgeGroup;
    /**
     * Publish the cached commands with a delay of 100ms to group multiple commands into one.
     * It optimizes the number of messages sent to the MQTT broker for huge scenes on the controller.
     *
     * @param {string} command - The command to publish, defaults to 'cachedPublishLight'
     * @param {Payload} payload - The optional payload to add to the cached publish payload
     * @param {number} transitionTime - The optional transition time to add to the cached publish payload
     */
    protected cachePublish(command?: string, payload?: Payload, transitionTime?: number | null): void;
    /**
     * Set the light attributes in the cache payload reading the clusters attributes.
     * It is used when turning on the light to send the current stored attributes in one message.
     *
     * @param {MatterbridgeEndpoint} endpoint - The endpoint to get the attributes from
     * @param {string} postfix - The postfix to add to the attribute names in the payload (e.g. '', '_1', '_2', etc.)
     */
    protected setCachePublishAttributes(endpoint: MatterbridgeEndpoint, postfix?: string): void;
    private saveCommands;
    protected onCommandHandler(data: CommandHandlerData): void;
    protected offCommandHandler(data: CommandHandlerData): void;
    protected toggleCommandHandler(data: CommandHandlerData): void;
    protected moveToLevelCommandHandler(data: CommandHandlerDataMap['LevelControl.moveToLevel']): void;
    protected moveToLevelWithOnOffCommandHandler(data: CommandHandlerDataMap['LevelControl.moveToLevelWithOnOff']): void;
    protected moveToColorTemperatureCommandHandler(data: CommandHandlerDataMap['ColorControl.moveToColorTemperature']): void;
    protected moveToColorCommandHandler(data: CommandHandlerDataMap['ColorControl.moveToColor']): void;
    protected moveToHueCommandHandler(data: CommandHandlerDataMap['ColorControl.moveToHue']): void;
    protected moveToSaturationCommandHandler(data: CommandHandlerDataMap['ColorControl.moveToSaturation']): void;
    protected moveToHueAndSaturationCommandHandler(data: CommandHandlerDataMap['ColorControl.moveToHueAndSaturation']): void;
    protected addBridgedDeviceBasicInformation(): MatterbridgeEndpoint;
    protected addPowerSource(): MatterbridgeEndpoint;
    /**
     * Verifies that all required server clusters are present on the main endpoint and child endpoints.
     *
     * @param {MatterbridgeEndpoint} endpoint - The device endpoint to verify.
     * @returns {boolean} True if all required server clusters are present, false otherwise.
     *
     * @remarks
     * This method checks if all required server clusters are present on the main endpoint and its child endpoints.
     * It logs an error message if any required server cluster is missing and returns false. If all required server
     * clusters are present, it returns true.
     */
    protected verifyMutableDevice(endpoint: MatterbridgeEndpoint): boolean;
    /**
     * Configures the device by setting up the WindowCovering and DoorLock clusters if they are present.
     *
     * @returns {Promise<void>} A promise that resolves when the configuration is complete.
     *
     * @remarks
     * This method configures the device by checking for the presence of the WindowCovering and DoorLock clusters.
     * If the WindowCovering cluster is present, it sets the target as the current position and stops any ongoing
     * movement. If the DoorLock cluster is present, it retrieves the lock state and triggers the appropriate lock
     * operation event based on the current state.
     */
    configure(): Promise<void>;
    /**
     * Updates the attribute of a cluster on a device endpoint if the value has changed.
     *
     * @param {Endpoint} deviceEndpoint - The device endpoint to update.
     * @param {string | undefined} childEndpointName - The name of the child endpoint, if any.
     * @param {number} clusterId - The ID of the cluster to update.
     * @param {string} attributeName - The name of the attribute to update.
     * @param {PayloadValue} value - The new value of the attribute.
     * @param {string[]} [lookup] - Optional lookup array for converting string values to indices.
     *
     * @remarks
     * This method checks if the specified attribute of a cluster on a device endpoint has changed. If the attribute
     * has changed, it updates the attribute with the new value. If a lookup array is provided, it converts string
     * values to their corresponding indices in the lookup array. The method logs the update process and handles any
     * errors that occur during the update.
     */
    protected updateAttributeIfChanged(deviceEndpoint: MatterbridgeEndpoint, childEndpointName: string | undefined, clusterId: number, attributeName: string, value: PayloadValue, lookup?: string[]): void;
    /**
     * Publishes a command to the specified entity with the given payload.
     *
     * @param {string} command - The command to execute.
     * @param {string} entityName - The name of the entity to publish the command to.
     * @param {Payload} payload - The payload of the command.
     *
     * @remarks
     * This method logs the execution of the command and publishes the command to the specified entity.
     * If the entity name starts with 'bridge/request', it publishes the payload without a 'set' suffix.
     * Otherwise, it publishes the payload with a 'set' suffix.
     */
    protected publishCommand(command: string, entityName: string, payload: Payload): void;
    /**
     * Logs the property map of the Zigbee entity.
     *
     * @remarks
     * This method iterates over the property map of the Zigbee entity and logs each property's details,
     * including its name, type, values, minimum and maximum values, unit, and endpoint.
     */
    protected logPropertyMap(): void;
}
/**
 * Represents a Zigbee group entity.
 *
 * @class
 * @augments {ZigbeeEntity}
 */
export declare class ZigbeeGroup extends ZigbeeEntity {
    /**
     * Creates an instance of ZigbeeGroup.
     *
     * @param {ZigbeePlatform} platform - The Zigbee platform instance.
     * @param {BridgeGroup} group - The bridge group instance.
     */
    private constructor();
    /**
     * Creates a new ZigbeeGroup instance.
     *
     * @param {ZigbeePlatform} platform - The Zigbee platform instance.
     * @param {BridgeGroup} group - The bridge group instance.
     * @returns {Promise<ZigbeeGroup>} A promise that resolves to the created ZigbeeGroup instance.
     *
     * @remarks
     * This method initializes a new ZigbeeGroup instance, sets up its properties, and configures the device
     * based on the group members. It also adds command handlers for the group.
     */
    static create(platform: ZigbeePlatform, group: BridgeGroup): Promise<ZigbeeGroup>;
}
/**
 * Represents a Zigbee device entity.
 *
 * @class
 * @augments {ZigbeeEntity}
 */
export declare class ZigbeeDevice extends ZigbeeEntity {
    /**
     * Represents a Zigbee device entity.
     *
     * @param {ZigbeePlatform} platform - The Zigbee platform instance.
     * @param {BridgeDevice} device - The bridge device instance.
     * @class
     * @augments {ZigbeeEntity}
     */
    private constructor();
    /**
     * Creates a new ZigbeeDevice instance.
     *
     * @param {ZigbeePlatform} platform - The Zigbee platform instance.
     * @param {BridgeDevice} device - The bridge device instance.
     * @returns {Promise<ZigbeeDevice>} A promise that resolves to the created ZigbeeDevice instance.
     *
     * @remarks
     * This method initializes a new ZigbeeDevice instance, sets up its properties, and configures the device
     * based on the device definition and options. It also adds command handlers for the device.
     */
    static create(platform: ZigbeePlatform, device: BridgeDevice): Promise<ZigbeeDevice>;
}
export {};
//# sourceMappingURL=entity.d.ts.map