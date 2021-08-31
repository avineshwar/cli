import { PluginManager } from 'live-plugin-manager' // TODO: replace with homegrown solution
import { Logger } from '@cloudgraph/sdk'
import { cosmiconfigSync } from 'cosmiconfig'
import path from 'path'
import fs from 'fs'
import satisfies from 'semver/functions/satisfies'

export class Manager {
  constructor(config: any) {
    this.pluginManager = new PluginManager({
      pluginsPath: path.resolve(__dirname, '../plugins'),
    })
    this.plugins = {}
    this.logger = config.logger
    this.devMode = config.devMode
    this.cliConfig = config.cliConfig
  }

  plugins: Record<string, any>

  cliConfig: any

  logger: Logger

  pluginManager: PluginManager

  devMode: boolean

  async getProviderPlugin(provider: string): Promise<any> {
    /**
     * Determine if the user has passed a provider and prompt them if not
     */
    let plugin
    let providerNamespace = '@cloudgraph'
    let providerName = provider

    if (provider.includes('/')) {
      [providerNamespace, providerName] = provider.split('/')
      this.logger.info(
        `Installing community provider ${providerName} from namespace ${providerNamespace}`
      )
    }
    if (this.plugins[providerName]) {
      return this.plugins[providerName]
    }
    const checkSpinner = this.logger.startSpinner(
      `Checking for ${providerName} module...`
    )
    try {
      const importPath = `${providerNamespace}/cg-provider-${providerName}`
      if (process.env.NODE_ENV === 'development' || this.devMode) {
        const isValidVersion = await this.checkRequiredVersion(importPath)
        if (!isValidVersion) {
          throw new Error('Version check failed')
        }
        // TODO: talk with live-plugin-manager maintainer on why above doesnt work but below does??
        plugin = await import(importPath)
      } else {
        const installOra = this.logger.startSpinner(
          `Installing ${providerName} plugin`
        )
        const providerVersion = this.getProviderVersionFromLock(provider)
        this.logger.info(`Requiring ${provider} module version: ${providerVersion}`)
        await this.pluginManager.install(importPath, providerVersion)
        const isValidVersion = await this.checkRequiredVersion(importPath)
        if (!isValidVersion) {
          throw new Error('Version check failed')
        }
        installOra.succeed(`${providerName} plugin installed successfully!`)
        plugin = this.pluginManager.require(importPath)
      }
    } catch (error: any) {
      console.log(error)
      checkSpinner.fail(`Manager failed to install plugin for ${providerName}`)
      throw new Error('FAILED to find plugin!!')
    }
    checkSpinner.succeed(`${providerName} module check complete`)
    this.plugins[providerName] = plugin
    return plugin
  }
  
  async checkRequiredVersion(importPath: string): Promise<boolean> {
    let providerInfo
    if (process.env.NODE_ENV === 'development' || this.devMode) {
      providerInfo = await import(`${importPath}/package.json`)
    } else {
      providerInfo = this.pluginManager.require(
        `${importPath}/package.json`
      )
    }
    const providerVersion = providerInfo?.version
    const requiredVersion = providerInfo?.cloudGraph?.version
    if (!requiredVersion) {
      this.logger.warn(
        'No required cli version found in provider module, assuming compatability'
      )
      return true
    }
    const test = satisfies(this.cliConfig.version, requiredVersion)
    if (!test) {
      const errText = 
        `Provider ${importPath}@${providerVersion} requires cli version ${requiredVersion} but cli version is ${this.cliConfig.version}`
      this.logger.error(errText)
      return false
    }
    return true
  }

  getProviderVersionFromLock(provider: string): string {
    const lockPath = path.join(this.cliConfig.configDir, '.cloud-graph.lock.json')
    let config
    try {
      config = cosmiconfigSync('cloud-graph').load(
        lockPath
      )
    } catch (error: any) {
      this.logger.info('No lock file found for Cloud Graph, creating one...')
    }
    if (!config?.config) {
      const data = {
        [provider]: 'latest'
      }
      fs.writeFileSync(lockPath, JSON.stringify(data, null, 2))
      return 'latest'
    }
    const lockFile = config.config
    if (!lockFile[provider]) {
      const newLockFile = {
        ...lockFile,
        [provider]: 'latest'
      }
      fs.writeFileSync(lockPath, JSON.stringify(newLockFile, null, 2))
      return 'latest'
    }
    return lockFile[provider]
  }
}

export default Manager
