/* eslint-disable no-console */
import {Opts} from 'cloud-graph-sdk'

import Command from './base'
import {fileUtils, getConnectedEntity} from '../utils'

const chalk = require('chalk')
const fs = require('fs')
const path = require('path')

const dataDir = 'cg-data'
export default class Scan extends Command {
  static description = 'Scan provider data based on your config';

  static examples = [
    `$ cloud-graph scan aws
Lets scan your AWS resources!
`,
  ];

  static strict = false;

  static flags = {
    ...Command.flags,
  };

  static args = Command.args

  async run() {
    const {argv, flags: {debug, dev: devMode}} = this.parse(Scan)
    // const dgraphHost = this.getDgraphHost()
    const opts: Opts = {logger: this.logger, debug, devMode}
    let allProviers = argv

    // Run dgraph health check
    const storageEngine = this.getStorageEngine()
    const storageRunning = await storageEngine.healthCheck()
    /**
     * Handle 2 methods of scanning, either for explicitly passed providers OR
     * try to scan for all providers found within the config file
     * if we still have 0 providers, fail and exit.
     */
    if (allProviers.length >= 1) {
      this.logger.log(`Scanning for providers: ${allProviers}`)
    } else {
      this.logger.log('Scanning for providers found in config')
      const config = this.getCGConfig()
      allProviers = Object.keys(config).filter((val: string) => val !== 'cloudGraph')
      if (allProviers.length === 0) {
        this.logger.log(
          'Error, there are no providers configured and none were passed to scan'
        )
        this.exit()
      }
    }

    /**
     * loop through providers and attempt to scan each of them
     */
    const schema: any[] = []
    const promises: Promise<any>[] = []

    // TODO: how to not loop through providers twice
    for (const provider of allProviers) {
      this.logger.log(`uploading Schema for ${provider}`)
      const client = await this.getProviderClient(provider)
      // console.log(config)
      const {
        getSchema,
      } = client
      const providerSchema: any[] = getSchema()
      schema.push(...providerSchema)
      fileUtils.writeGraphqlSchemaToFile(providerSchema, provider)
    }
    // Write combined schemas to Dgraph
    fileUtils.writeGraphqlSchemaToFile(schema)

    // Push schema to dgraph if dgraph is running
    if (storageRunning) {
      try {
        await storageEngine.setSchema(schema)
      } catch (error: any) {
        this.logger.log(error, {verbose: true, level: error})
        this.logger.log(`There was an issue pushing schema for providers: ${allProviers.join(' | ')} to dgraph at ${this.storageEngine.host}`, {level: 'error'})
        this.exit()
      }
    }
    for (const provider of allProviers) {
      this.logger.log(`Beginning SCAN for ${provider}`)
      const client = await this.getProviderClient(provider)
      if (!client) {
        continue
      }
      const {
        getCredentials,
        getService,
        getIdentity,
        getData,
        properties,
      } = client
      const config = this.getCGConfig(provider)
      const providerConfig = config ? config : {
        regions: properties.regions.join(','),
        resources: Object.values(properties.services).join(','),
      }
      const creds: any = await getCredentials(opts)
      const {accountId} = await getIdentity({credentials: creds, opts})
      this.logger.log(providerConfig)
      const providerData = await getData({
        regions: providerConfig.regions,
        resources: providerConfig.resources,
        credentials: creds,
        opts,
      })
      /**
       * Grab all AWS SDK data for the requested regions/resources
       */
      // const awsSdkData = await getDataFromAwsSdk({regions: 'us-east-1', resources: '', credentials: creds, forceFetchAsgs: false, additionalResources: 'ec2_instance,alb,route53'})
      // console.log(JSON.stringify(awsSdkData))
      // eslint-disable-next-line no-console
      // step 1 grab the data with awsSdkData
      // step 2 format the data for flat file (enterprise: needs to also format for sumerian ui data => this is used to make more connections between data)
      // step 2.1 we need to really understand what the best way to format the data for OS and enterprise
      // step 3 enterprise => how do we flip back and forth between dgraph and 3d ENV
      // do we need to flip from 3d to dgraph?
      // converters: new flat data shape, from flat data to dgraph converter. from flat data to 3d converter. dgraph to 3d converter as well.
      // We need to know the schema, flat file needs entites AND all the connections
      // get all the data, make all the connection between data, format data for flat file
      // take the connections and build relations
      // graphql needs this at compile time ^
      // we have kmsRawData (what comes from the sdk and possible gets type from here) KmsKey
      // is there a good valid reason to have "middle layer". other option is take raw data, build connections from that in another data obj, formats the non-connection keys from the type, make connections to build our schema types (KMSKey)

      const allTagData: any[] = []
      const result: { entities: { name: any; data: any }[]; connections: any } =
        {
          entities: [],
          connections: {},
        }
      /**
       * Loop through the aws sdk data to format entities and build connections
       * 1. Format data with provider service format function
       * 2. build connections for data with provider service connections function
       * 3. spread new connections over result.connections
       * 4. push the array of formatted entities into result.entites
       */
      for (const serviceData of providerData) {
        const serviceClass = getService(serviceData.name)
        // console.log(serviceClass)
        // TODO: change to a loop through region names
        const data = serviceData.data['us-east-1']
        const entities = []
        for (const serviceInstance of data) {
          entities.push(
            serviceClass.format({
              service: serviceInstance,
              region: 'us-east-1',
              account: accountId,
            })
          )
          if (typeof serviceClass.getConnections === 'function') {
            result.connections = {
              ...result.connections,
              ...serviceClass.getConnections({
                service: serviceInstance,
                region: 'us-east-1',
                account: accountId,
                data: providerData,
              }),
            }
          }
        }
        result.entities.push({name: serviceData.name, data: entities})
      }
      // TODO: if we are scanning multi providers, do we want to save as one giant file?
      fileUtils.makeDirIfNotExists(dataDir)
      fs.writeFileSync(
        path.join(
          process.cwd(),
          `${dataDir}/${provider}_${accountId}_${Date.now()}.json`
        ),
        JSON.stringify(result, null, 2)
      )
      /**
       * Loop through the result entities and for each entity:
       * Look in result.connections for [key = entity.arn]
       * Loop through the connections for entity and determine its resource type
       * Find entity in result.entites that matches the id found in connections
       * Build connectedEntity by pushing the matched entity into the field corresponding to that entity (alb.ec2Instance => [ec2Instance])
       * Push connected entity into dgraph
       */
      for (const entity of result.entities) {
        const {name, data} = entity
        const {mutation} = getService(name)
        const connectedData = data.map((service: any) => getConnectedEntity(service, result, opts))
        if (storageRunning) {
          const axiosPromise = storageEngine.push({
            query: mutation,
            variables: {
              input: connectedData,
            },
          })
          promises.push(axiosPromise)
        }
      }
    }
    await Promise.all(promises)
    this.logger.log(`Your data for ${allProviers.join(' | ')} is now being served at ${chalk.underline.green(storageEngine.host)}`, {level: 'success'})
    this.exit()
  }
}
