// @flow

import { resolve as resolvePath } from 'path'
import EventEmitter from 'eventemitter3'
import { mergeDeepRight } from 'ramda'
import { encaseP } from 'fluture'
import Debug from 'debug'
import uuidv4 from '../vendor/uuidv4'
import { TDLib } from './tdlib-ffi'
import { deepRenameKey, deepRenameKey_ } from './util'
import {
  getAuthCode as defaultGetAuthCode,
  getPassword as defaultGetPassword,
  getName as defaultGetName
} from './prompt'

import type { TDLibClient, ITDLibJSON } from 'tdl-shared'

import type {
  ConfigType,
  StrictConfigType,
  LoginDetails,
  StrictLoginDetails
} from './types'

import type {
  TDFunction,
  // TDObject,
  Update,
  updateAuthorizationState,
  error as Td$error,
  ConnectionState,
  Invoke,
  InvokeFuture,
  Execute,
  Omit
} from '../types/tdlib'

import type * as types from '../types/tdlib'

const debug = Debug('tdl:client')
const debugEmitter = Debug('tdl:client:emitter')
const debugRes = Debug('tdl:client:response')
const debugReq = Debug('tdl:client:request')

const defaultLoginDetails: StrictLoginDetails = {
  type: 'user',
  phoneNumber: '',
  getAuthCode: defaultGetAuthCode,
  getPassword: defaultGetPassword,
  getName: defaultGetName
}

const defaultOptions: $Exact<StrictConfigType> = {
  binaryPath: '',
  databaseDirectory: '_td_database',
  filesDirectory: '_td_files',
  databaseEncryptionKey: '',
  verbosityLevel: 2,
  skipOldUpdates: false,
  useTestDc: false,
  useMutableRename: false,
  useDefaultVerbosityLevel: false,
  tdlibParameters: {
    use_message_database: true,
    use_secret_chats: false,
    system_language_code: 'en',
    application_version: '1.0',
    device_model: 'tdlib',
    system_version: 'node',
    enable_storage_optimizer: true
  }
}

type FetchingPromiseCallback = {
  resolve: (result: Object/* TDObject */) => void,
  reject: (error: Td$error) => void
}

export type On =
  & ((event: 'update', listener: (update: Update) => void) => Client)
  & ((event: 'error', listener: (err: Td$error | Error) => void) => Client)
  & ((event: 'destroy', listener: () => void) => Client)
  & ((event: 'auth-needed', listener: () => void) => Client)
  & ((event: 'auth-not-needed', listener: () => void) => Client)
  & ((event: 'response', listener: (res: any) => void) => Client)

export type Emit =
  & ((event: 'update', update: Update) => void)
  & ((event: 'error', err: Td$error | Error) => void)
  & ((event: 'destroy') => void)
  & ((event: 'auth-needed') => void)
  & ((event: 'auth-not-needed') => void)
  & ((event: 'response', res: any) => void)

export type RemoveListener =
  & ((event: 'update', listener: Function, once?: boolean) => void)
  & ((event: 'error', listener: Function, once?: boolean) => void)
  & ((event: 'destroy', listener: Function, once?: boolean) => void)
  & ((event: 'auth-needed', listener: Function, once?: boolean) => void)
  & ((event: 'auth-not-needed', listener: Function, once?: boolean) => void)
  & ((event: 'response', listener: Function, once?: boolean) => void)

const noop = () => {}

export class Client {
  +_options: StrictConfigType;
  +_emitter = new EventEmitter();
  +_fetching: Map<string, FetchingPromiseCallback> = new Map();
  +_tdlib: ITDLibJSON;
  _client: ?TDLibClient;
  _connectionState: ConnectionState = { _: 'connectionStateConnecting' };

  _connectResolver: (result: void) => void = noop;
  _connectRejector: null | (error: any) => void = null;

  _authNeeded: boolean = false;

  _loginDetails: StrictLoginDetails;

  _loginResolver: null | (result: void) => void = null;

  _paused = false;

  constructor (options: ConfigType = {}) {
    this._options = (mergeDeepRight(defaultOptions, options): StrictConfigType)

    if (!options.apiId)
      throw new TypeError('Valid api_id must be provided.')

    if (!options.apiHash)
      throw new TypeError('Valid api_hash must be provided.')

    this._tdlib = this._options.tdlibInstance
      || new TDLib(this._options.binaryPath || undefined)
  }

  static create (options: ConfigType = {}): Client {
    return new Client(options)
  }

  static fromTDLib (tdlibInstance: ITDLibJSON, options: ConfigType = {}): Client {
    return new Client({
      ...options,
      tdlibInstance
    })
  }

  async _init (): Promise<void> {
    try {
      if (!this._options.useDefaultVerbosityLevel)
        this.setLogVerbosityLevel(this._options.verbosityLevel)

      this._client = await this._tdlib.create()
    } catch (err) {
      if (this._connectRejector)
        this._connectRejector(`Error while creating client: ${err}`)
    }

    this._loop()
  }

  connect = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      this._connectResolver = resolve
      this._connectRejector = reject
      this._init()
    })
  }

  login = (getLoginDetails: () => LoginDetails): Promise<void> => {
    debug('client.login()')
    this._emitter.once('auth-needed', () => {
      this._loginDetails = mergeDeepRight(
        defaultLoginDetails, getLoginDetails())
    })
    return new Promise(resolve => {
      this._loginResolver = resolve
      this._emitter.emit('_login')
    })
  }

  _waitLogin (): Promise<void> {
    debug('waitLogin.', this._loginResolver)
    return new Promise(resolve => {
      if (this._loginResolver) return resolve()
      this._emitter.once('_login', () => resolve())
    })
  }

  connectAndLogin = async (fn: () => LoginDetails): Promise<void> => {
    await this.connect()
    return this.login(fn)
  }

  pause = (): void => {
    debug('pause')
    if (this._paused === false)
      this._paused = true
  }

  resume = (): void => {
    debug('resume')
    if (this._paused === true) {
      this._emitter.emit('_resume')
      this._paused = false
    }
  }

  _waitResume (): Promise<void> {
    return new Promise(resolve => {
      if (this._paused === false) resolve()
      this._emitter.once('_resume', () => resolve())
    })
  }

  on: On = (event, listener) => {
    this._emitter.on(event, listener)
    return this
  }

  once: On = (event, listener) => {
    this._emitter.once(event, listener)
    return this
  }

  emit: Emit = (event, value) => {
    debugEmitter('emit', event, value)
    this._emitter.emit(event, value)
  }

  removeListener: RemoveListener = (event, listener, once = false) => {
    this._emitter.removeListener(event, listener, undefined, once)
  }

  invoke: Invoke = async query => {
    const id = uuidv4()
    // $FlowOff
    query['@extra'] = id
    const receiveResponse = new Promise((resolve, reject) => {
      try {
        this._fetching.set(id, { resolve, reject })
        // // timeout after 10 seconds
        // setTimeout(() => {
        //   delete this._fetching[id]
        //   reject('Query timed out after 10 seconds.')
        // }, 1000 * 10)
      } catch (e) {
        this._catchError(e)
      }
    })
    await this._send(query)

    return receiveResponse
  }

  invokeFuture: InvokeFuture =
    (encaseP(this.invoke): $FlowOff)

  destroy = (): void => {
    if (!this._client) return
    this._tdlib.destroy(this._client)
    this._client = null
    this.emit('destroy')
  }

  setLogMaxFileSize = (maxFileSize: number | string): void => {
    this._tdlib.setLogMaxFileSize(maxFileSize)
  }

  setLogFilePath = (path: string): number =>
    this._tdlib.setLogFilePath(path)

  setLogVerbosityLevel = (verbosity: number): void => {
    this._tdlib.setLogVerbosityLevel(verbosity)
  }

  setLogFatalErrorCallback = (fn: null | (errorMessage: string) => void): void => {
    this._tdlib.setLogFatalErrorCallback(fn)
  }

  execute: Execute = query => {
    debugReq('execute', query)
    if (!this._client) return null
    const { _client: client } = this
    const tdQuery = deepRenameKey('_', '@type', query)
    const tdResponse = this._tdlib.execute(client, tdQuery)
    return tdResponse && deepRenameKey('@type', '_', tdResponse)
  }

  async _send (query: TDFunction): Promise<void> {
    debugReq('send', query)
    if (!this._client) return
    const { _client: client } = this
    const tdQuery = deepRenameKey('_', '@type', query)
    this._tdlib.send(client, tdQuery)
  }

  async _receive (timeout: number = 10): Promise<Object/*TDObject*/ | null> {
    if (!this._client) return Promise.resolve(null)
    const tdResponse = await this._tdlib.receive(this._client, timeout)
    return tdResponse && (this._options.useMutableRename
      ? deepRenameKey_('@type', '_', tdResponse)
      : deepRenameKey('@type', '_', tdResponse))
  }

  _catchError (err: mixed): void {
    debug('catchError', err)

    const message = (err && typeof err === 'object' && err.message) || err

    this.emit('error', new Error(message))

    if (this._connectRejector)
      this._connectRejector(err)
  }

  _authRequired (): StrictLoginDetails {
    this._authNeeded = true
    this.emit('auth-needed')
    return this._loginDetails
  }

  async _loop (): Promise<void> {
    while (true) {
      try {
        const response = await this._receive()

        if (!this._client) return

        if (this._paused === true)
          await this._waitResume()

        if (response)
          await this._handleResponse(response)
        else
          debug('Response is empty.')
      } catch (e) {
        this._catchError(e)
      }
    }
    debug('_loop end')
  }

  async _handleResponse (res: Object/*TDObject*/): Promise<void> {
    this.emit('response', res)
    debugRes(res)

    if (res._ === 'error')
      return this._handleError(res)

    // $Flow//Off
    const id = res['@extra']
    const promise = this._fetching.get(id)

    if (promise) {
      // $Flow//Off
      delete res['@extra']
      promise.resolve(res)
      this._fetching.delete(id)
    } else if (id !== null && res._ !== 'ok') {
      // $Flow//Off
      return this._handleUpdate(res)
    }
  }

  async _handleUpdate (update: Update): Promise<void> {
    switch (update._) {
      case 'updateAuthorizationState':
        this._handleAuth(update).catch(e => this._catchError(e))
        return

      case 'updateConnectionState':
        debug('New connection state:', update.state)
        this._connectionState = update.state
        this.emit('update', update)
        return

      default:
        if (this._options.skipOldUpdates && this._connectionState._ !== 'connectionStateReady')
          return
        this.emit('update', update)
    }
  }

  async _handleAuth (update: updateAuthorizationState) {
    const authorizationState = update.authorization_state

    debug('New authorization state:', authorizationState._)

    switch (authorizationState._) {
      case 'authorizationStateWaitTdlibParameters':
        return this._send({
          _: 'setTdlibParameters',
          'parameters': {
            ...this._options.tdlibParameters,
            _: 'tdlibParameters',
            database_directory: resolvePath(this._options.databaseDirectory),
            files_directory: resolvePath(this._options.filesDirectory),
            api_id: this._options.apiId,
            api_hash: this._options.apiHash,
            use_test_dc: this._options.useTestDc
          }
        })

      case 'authorizationStateWaitEncryptionKey':
        await this._send({
          _: 'checkDatabaseEncryptionKey',
          encryption_key: this._options.databaseEncryptionKey
        })

        this._connectRejector = null
        return this._connectResolver()

      case 'authorizationStateClosed':
        return this.destroy()

      case 'authorizationStateReady':
        if (this._authNeeded === false) this.emit('auth-not-needed')
    }

    await this._waitLogin()
    debug('waitLogin end.', authorizationState._)

    switch (authorizationState._) {
      case 'authorizationStateWaitPhoneNumber': {
        const loginDetails = this._authRequired()

        return loginDetails.type === 'user'
          ? this._send({
            _: 'setAuthenticationPhoneNumber',
            phone_number: loginDetails.phoneNumber
          })
          : this._send({
            _: 'checkAuthenticationBotToken',
            token: loginDetails.token
          })
      }

      case 'authorizationStateWaitCode': {
        const loginDetails = this._authRequired()
        if (loginDetails.type !== 'user') return

        const code = await loginDetails.getAuthCode(false)

        if (authorizationState.is_registered === false) {
          const { firstName, lastName = '' } = await loginDetails.getName()
          return this._send({
            _: 'checkAuthenticationCode',
            code,
            first_name: firstName,
            last_name: lastName
          })
        }

        return this._send({
          _: 'checkAuthenticationCode',
          code
        })
      }

      case 'authorizationStateWaitPassword': {
        const loginDetails = this._authRequired()
        if (loginDetails.type !== 'user') return

        const passwordHint = authorizationState.password_hint
        const password = await loginDetails.getPassword(passwordHint, false)
        return this._send({
          _: 'checkAuthenticationPassword',
          password
        })
      }

      case 'authorizationStateReady':
        const loginResolver = this._loginResolver || noop
        return loginResolver()
    }
  }

  async _handleError (error: Td$error): Promise<void> {
    const loginDetails = this._loginDetails

    switch (error.message) {
      case 'PHONE_CODE_EMPTY':
      case 'PHONE_CODE_INVALID': {
        if (loginDetails.type !== 'user') return
        const code = await loginDetails.getAuthCode(true)
        return this._send({
          _: 'checkAuthenticationCode',
          code
        })
      }

      case 'PASSWORD_HASH_INVALID': {
        if (loginDetails.type !== 'user') return
        const password = await loginDetails.getPassword('', true)
        return this._send({
          _: 'checkAuthenticationPassword',
          password
        })
      }

      default: {
        // $FlowOff
        const id = error['@extra']
        const promise = this._fetching.get(id)

        if (promise) {
          // $FlowOff
          delete error['@extra']
          promise.reject(error)
          this._fetching.delete(id)
        } else {
          this.emit('error', error)
        }
      }
    }
  }

  getInfo = (id: number): Promise<User | Chat | null> => {
    if (!id || isNaN(id)) return null;

    id = parseInt(id);

    if (id < 0) {
      return this.getChat({
        chat_id: id,
      });
    } else {
      return this.getUser({
        user_id: id,
      });
    }
  }

  getAuthorizationState (params: Omit<types.getAuthorizationState, '_'>): Promise<any> { return this.invoke({ _: 'getAuthorizationState', ...params }); }
  setTdlibParameters (params: Omit<types.setTdlibParameters, '_'>): Promise<any> { return this.invoke({ _: 'setTdlibParameters', ...params }); }
  checkDatabaseEncryptionKey (params: Omit<types.checkDatabaseEncryptionKey, '_'>): Promise<any> { return this.invoke({ _: 'checkDatabaseEncryptionKey', ...params }); }
  setAuthenticationPhoneNumber (params: Omit<types.setAuthenticationPhoneNumber, '_'>): Promise<any> { return this.invoke({ _: 'setAuthenticationPhoneNumber', ...params }); }
  resendAuthenticationCode (params: Omit<types.resendAuthenticationCode, '_'>): Promise<any> { return this.invoke({ _: 'resendAuthenticationCode', ...params }); }
  checkAuthenticationCode (params: Omit<types.checkAuthenticationCode, '_'>): Promise<any> { return this.invoke({ _: 'checkAuthenticationCode', ...params }); }
  checkAuthenticationPassword (params: Omit<types.checkAuthenticationPassword, '_'>): Promise<any> { return this.invoke({ _: 'checkAuthenticationPassword', ...params }); }
  requestAuthenticationPasswordRecovery (params: Omit<types.requestAuthenticationPasswordRecovery, '_'>): Promise<any> { return this.invoke({ _: 'requestAuthenticationPasswordRecovery', ...params }); }
  recoverAuthenticationPassword (params: Omit<types.recoverAuthenticationPassword, '_'>): Promise<any> { return this.invoke({ _: 'recoverAuthenticationPassword', ...params }); }
  checkAuthenticationBotToken (params: Omit<types.checkAuthenticationBotToken, '_'>): Promise<any> { return this.invoke({ _: 'checkAuthenticationBotToken', ...params }); }
  logOut (params: Omit<types.logOut, '_'>): Promise<any> { return this.invoke({ _: 'logOut', ...params }); }
  close (params: Omit<types.close, '_'>): Promise<any> { return this.invoke({ _: 'close', ...params }); }
  setDatabaseEncryptionKey (params: Omit<types.setDatabaseEncryptionKey, '_'>): Promise<any> { return this.invoke({ _: 'setDatabaseEncryptionKey', ...params }); }
  getPasswordState (params: Omit<types.getPasswordState, '_'>): Promise<any> { return this.invoke({ _: 'getPasswordState', ...params }); }
  setPassword (params: Omit<types.setPassword, '_'>): Promise<any> { return this.invoke({ _: 'setPassword', ...params }); }
  getRecoveryEmailAddress (params: Omit<types.getRecoveryEmailAddress, '_'>): Promise<any> { return this.invoke({ _: 'getRecoveryEmailAddress', ...params }); }
  setRecoveryEmailAddress (params: Omit<types.setRecoveryEmailAddress, '_'>): Promise<any> { return this.invoke({ _: 'setRecoveryEmailAddress', ...params }); }
  requestPasswordRecovery (params: Omit<types.requestPasswordRecovery, '_'>): Promise<any> { return this.invoke({ _: 'requestPasswordRecovery', ...params }); }
  recoverPassword (params: Omit<types.recoverPassword, '_'>): Promise<any> { return this.invoke({ _: 'recoverPassword', ...params }); }
  createTemporaryPassword (params: Omit<types.createTemporaryPassword, '_'>): Promise<any> { return this.invoke({ _: 'createTemporaryPassword', ...params }); }
  getTemporaryPasswordState (params: Omit<types.getTemporaryPasswordState, '_'>): Promise<any> { return this.invoke({ _: 'getTemporaryPasswordState', ...params }); }
  processDcUpdate (params: Omit<types.processDcUpdate, '_'>): Promise<any> { return this.invoke({ _: 'processDcUpdate', ...params }); }
  getMe (params: Omit<types.getMe, '_'>): Promise<any> { return this.invoke({ _: 'getMe', ...params }); }
  getUser (params: Omit<types.getUser, '_'>): Promise<any> { return this.invoke({ _: 'getUser', ...params }); }
  getUserFullInfo (params: Omit<types.getUserFullInfo, '_'>): Promise<any> { return this.invoke({ _: 'getUserFullInfo', ...params }); }
  getBasicGroup (params: Omit<types.getBasicGroup, '_'>): Promise<any> { return this.invoke({ _: 'getBasicGroup', ...params }); }
  getBasicGroupFullInfo (params: Omit<types.getBasicGroupFullInfo, '_'>): Promise<any> { return this.invoke({ _: 'getBasicGroupFullInfo', ...params }); }
  getSupergroup (params: Omit<types.getSupergroup, '_'>): Promise<any> { return this.invoke({ _: 'getSupergroup', ...params }); }
  getSupergroupFullInfo (params: Omit<types.getSupergroupFullInfo, '_'>): Promise<any> { return this.invoke({ _: 'getSupergroupFullInfo', ...params }); }
  getSecretChat (params: Omit<types.getSecretChat, '_'>): Promise<any> { return this.invoke({ _: 'getSecretChat', ...params }); }
  getChat (params: Omit<types.getChat, '_'>): Promise<any> { return this.invoke({ _: 'getChat', ...params }); }
  getMessage (params: Omit<types.getMessage, '_'>): Promise<any> { return this.invoke({ _: 'getMessage', ...params }); }
  getRepliedMessage (params: Omit<types.getRepliedMessage, '_'>): Promise<any> { return this.invoke({ _: 'getRepliedMessage', ...params }); }
  getChatPinnedMessage (params: Omit<types.getChatPinnedMessage, '_'>): Promise<any> { return this.invoke({ _: 'getChatPinnedMessage', ...params }); }
  getMessages (params: Omit<types.getMessages, '_'>): Promise<any> { return this.invoke({ _: 'getMessages', ...params }); }
  getFile (params: Omit<types.getFile, '_'>): Promise<any> { return this.invoke({ _: 'getFile', ...params }); }
  getRemoteFile (params: Omit<types.getRemoteFile, '_'>): Promise<any> { return this.invoke({ _: 'getRemoteFile', ...params }); }
  getChats (params: Omit<types.getChats, '_'>): Promise<any> { return this.invoke({ _: 'getChats', ...params }); }
  searchPublicChat (params: Omit<types.searchPublicChat, '_'>): Promise<any> { return this.invoke({ _: 'searchPublicChat', ...params }); }
  searchPublicChats (params: Omit<types.searchPublicChats, '_'>): Promise<any> { return this.invoke({ _: 'searchPublicChats', ...params }); }
  searchChats (params: Omit<types.searchChats, '_'>): Promise<any> { return this.invoke({ _: 'searchChats', ...params }); }
  searchChatsOnServer (params: Omit<types.searchChatsOnServer, '_'>): Promise<any> { return this.invoke({ _: 'searchChatsOnServer', ...params }); }
  getTopChats (params: Omit<types.getTopChats, '_'>): Promise<any> { return this.invoke({ _: 'getTopChats', ...params }); }
  removeTopChat (params: Omit<types.removeTopChat, '_'>): Promise<any> { return this.invoke({ _: 'removeTopChat', ...params }); }
  addRecentlyFoundChat (params: Omit<types.addRecentlyFoundChat, '_'>): Promise<any> { return this.invoke({ _: 'addRecentlyFoundChat', ...params }); }
  removeRecentlyFoundChat (params: Omit<types.removeRecentlyFoundChat, '_'>): Promise<any> { return this.invoke({ _: 'removeRecentlyFoundChat', ...params }); }
  clearRecentlyFoundChats (params: Omit<types.clearRecentlyFoundChats, '_'>): Promise<any> { return this.invoke({ _: 'clearRecentlyFoundChats', ...params }); }
  checkChatUsername (params: Omit<types.checkChatUsername, '_'>): Promise<any> { return this.invoke({ _: 'checkChatUsername', ...params }); }
  getCreatedPublicChats (params: Omit<types.getCreatedPublicChats, '_'>): Promise<any> { return this.invoke({ _: 'getCreatedPublicChats', ...params }); }
  getGroupsInCommon (params: Omit<types.getGroupsInCommon, '_'>): Promise<any> { return this.invoke({ _: 'getGroupsInCommon', ...params }); }
  getChatHistory (params: Omit<types.getChatHistory, '_'>): Promise<any> { return this.invoke({ _: 'getChatHistory', ...params }); }
  deleteChatHistory (params: Omit<types.deleteChatHistory, '_'>): Promise<any> { return this.invoke({ _: 'deleteChatHistory', ...params }); }
  searchChatMessages (params: Omit<types.searchChatMessages, '_'>): Promise<any> { return this.invoke({ _: 'searchChatMessages', ...params }); }
  searchMessages (params: Omit<types.searchMessages, '_'>): Promise<any> { return this.invoke({ _: 'searchMessages', ...params }); }
  searchSecretMessages (params: Omit<types.searchSecretMessages, '_'>): Promise<any> { return this.invoke({ _: 'searchSecretMessages', ...params }); }
  searchCallMessages (params: Omit<types.searchCallMessages, '_'>): Promise<any> { return this.invoke({ _: 'searchCallMessages', ...params }); }
  searchChatRecentLocationMessages (params: Omit<types.searchChatRecentLocationMessages, '_'>): Promise<any> { return this.invoke({ _: 'searchChatRecentLocationMessages', ...params }); }
  getActiveLiveLocationMessages (params: Omit<types.getActiveLiveLocationMessages, '_'>): Promise<any> { return this.invoke({ _: 'getActiveLiveLocationMessages', ...params }); }
  getChatMessageByDate (params: Omit<types.getChatMessageByDate, '_'>): Promise<any> { return this.invoke({ _: 'getChatMessageByDate', ...params }); }
  getChatMessageCount (params: Omit<types.getChatMessageCount, '_'>): Promise<any> { return this.invoke({ _: 'getChatMessageCount', ...params }); }
  getPublicMessageLink (params: Omit<types.getPublicMessageLink, '_'>): Promise<any> { return this.invoke({ _: 'getPublicMessageLink', ...params }); }
  sendMessage (params: Omit<types.sendMessage, '_'>): Promise<any> { return this.invoke({ _: 'sendMessage', ...params }); }
  sendMessageAlbum (params: Omit<types.sendMessageAlbum, '_'>): Promise<any> { return this.invoke({ _: 'sendMessageAlbum', ...params }); }
  sendBotStartMessage (params: Omit<types.sendBotStartMessage, '_'>): Promise<any> { return this.invoke({ _: 'sendBotStartMessage', ...params }); }
  sendInlineQueryResultMessage (params: Omit<types.sendInlineQueryResultMessage, '_'>): Promise<any> { return this.invoke({ _: 'sendInlineQueryResultMessage', ...params }); }
  forwardMessages (params: Omit<types.forwardMessages, '_'>): Promise<any> { return this.invoke({ _: 'forwardMessages', ...params }); }
  sendChatSetTtlMessage (params: Omit<types.sendChatSetTtlMessage, '_'>): Promise<any> { return this.invoke({ _: 'sendChatSetTtlMessage', ...params }); }
  sendChatScreenshotTakenNotification (params: Omit<types.sendChatScreenshotTakenNotification, '_'>): Promise<any> { return this.invoke({ _: 'sendChatScreenshotTakenNotification', ...params }); }
  addLocalMessage (params: Omit<types.addLocalMessage, '_'>): Promise<any> { return this.invoke({ _: 'addLocalMessage', ...params }); }
  deleteMessages (params: Omit<types.deleteMessages, '_'>): Promise<any> { return this.invoke({ _: 'deleteMessages', ...params }); }
  deleteChatMessagesFromUser (params: Omit<types.deleteChatMessagesFromUser, '_'>): Promise<any> { return this.invoke({ _: 'deleteChatMessagesFromUser', ...params }); }
  editMessageText (params: Omit<types.editMessageText, '_'>): Promise<any> { return this.invoke({ _: 'editMessageText', ...params }); }
  editMessageLiveLocation (params: Omit<types.editMessageLiveLocation, '_'>): Promise<any> { return this.invoke({ _: 'editMessageLiveLocation', ...params }); }
  editMessageMedia (params: Omit<types.editMessageMedia, '_'>): Promise<any> { return this.invoke({ _: 'editMessageMedia', ...params }); }
  editMessageCaption (params: Omit<types.editMessageCaption, '_'>): Promise<any> { return this.invoke({ _: 'editMessageCaption', ...params }); }
  editMessageReplyMarkup (params: Omit<types.editMessageReplyMarkup, '_'>): Promise<any> { return this.invoke({ _: 'editMessageReplyMarkup', ...params }); }
  editInlineMessageText (params: Omit<types.editInlineMessageText, '_'>): Promise<any> { return this.invoke({ _: 'editInlineMessageText', ...params }); }
  editInlineMessageLiveLocation (params: Omit<types.editInlineMessageLiveLocation, '_'>): Promise<any> { return this.invoke({ _: 'editInlineMessageLiveLocation', ...params }); }
  editInlineMessageMedia (params: Omit<types.editInlineMessageMedia, '_'>): Promise<any> { return this.invoke({ _: 'editInlineMessageMedia', ...params }); }
  editInlineMessageCaption (params: Omit<types.editInlineMessageCaption, '_'>): Promise<any> { return this.invoke({ _: 'editInlineMessageCaption', ...params }); }
  editInlineMessageReplyMarkup (params: Omit<types.editInlineMessageReplyMarkup, '_'>): Promise<any> { return this.invoke({ _: 'editInlineMessageReplyMarkup', ...params }); }
  getTextEntities (params: Omit<types.getTextEntities, '_'>): Promise<any> { return this.invoke({ _: 'getTextEntities', ...params }); }
  parseTextEntities (params: Omit<types.parseTextEntities, '_'>): Promise<any> { return this.invoke({ _: 'parseTextEntities', ...params }); }
  getFileMimeType (params: Omit<types.getFileMimeType, '_'>): Promise<any> { return this.invoke({ _: 'getFileMimeType', ...params }); }
  getFileExtension (params: Omit<types.getFileExtension, '_'>): Promise<any> { return this.invoke({ _: 'getFileExtension', ...params }); }
  cleanFileName (params: Omit<types.cleanFileName, '_'>): Promise<any> { return this.invoke({ _: 'cleanFileName', ...params }); }
  getLanguagePackString (params: Omit<types.getLanguagePackString, '_'>): Promise<any> { return this.invoke({ _: 'getLanguagePackString', ...params }); }
  getInlineQueryResults (params: Omit<types.getInlineQueryResults, '_'>): Promise<any> { return this.invoke({ _: 'getInlineQueryResults', ...params }); }
  answerInlineQuery (params: Omit<types.answerInlineQuery, '_'>): Promise<any> { return this.invoke({ _: 'answerInlineQuery', ...params }); }
  getCallbackQueryAnswer (params: Omit<types.getCallbackQueryAnswer, '_'>): Promise<any> { return this.invoke({ _: 'getCallbackQueryAnswer', ...params }); }
  answerCallbackQuery (params: Omit<types.answerCallbackQuery, '_'>): Promise<any> { return this.invoke({ _: 'answerCallbackQuery', ...params }); }
  answerShippingQuery (params: Omit<types.answerShippingQuery, '_'>): Promise<any> { return this.invoke({ _: 'answerShippingQuery', ...params }); }
  answerPreCheckoutQuery (params: Omit<types.answerPreCheckoutQuery, '_'>): Promise<any> { return this.invoke({ _: 'answerPreCheckoutQuery', ...params }); }
  setGameScore (params: Omit<types.setGameScore, '_'>): Promise<any> { return this.invoke({ _: 'setGameScore', ...params }); }
  setInlineGameScore (params: Omit<types.setInlineGameScore, '_'>): Promise<any> { return this.invoke({ _: 'setInlineGameScore', ...params }); }
  getGameHighScores (params: Omit<types.getGameHighScores, '_'>): Promise<any> { return this.invoke({ _: 'getGameHighScores', ...params }); }
  getInlineGameHighScores (params: Omit<types.getInlineGameHighScores, '_'>): Promise<any> { return this.invoke({ _: 'getInlineGameHighScores', ...params }); }
  deleteChatReplyMarkup (params: Omit<types.deleteChatReplyMarkup, '_'>): Promise<any> { return this.invoke({ _: 'deleteChatReplyMarkup', ...params }); }
  sendChatAction (params: Omit<types.sendChatAction, '_'>): Promise<any> { return this.invoke({ _: 'sendChatAction', ...params }); }
  openChat (params: Omit<types.openChat, '_'>): Promise<any> { return this.invoke({ _: 'openChat', ...params }); }
  closeChat (params: Omit<types.closeChat, '_'>): Promise<any> { return this.invoke({ _: 'closeChat', ...params }); }
  viewMessages (params: Omit<types.viewMessages, '_'>): Promise<any> { return this.invoke({ _: 'viewMessages', ...params }); }
  openMessageContent (params: Omit<types.openMessageContent, '_'>): Promise<any> { return this.invoke({ _: 'openMessageContent', ...params }); }
  readAllChatMentions (params: Omit<types.readAllChatMentions, '_'>): Promise<any> { return this.invoke({ _: 'readAllChatMentions', ...params }); }
  createPrivateChat (params: Omit<types.createPrivateChat, '_'>): Promise<any> { return this.invoke({ _: 'createPrivateChat', ...params }); }
  createBasicGroupChat (params: Omit<types.createBasicGroupChat, '_'>): Promise<any> { return this.invoke({ _: 'createBasicGroupChat', ...params }); }
  createSupergroupChat (params: Omit<types.createSupergroupChat, '_'>): Promise<any> { return this.invoke({ _: 'createSupergroupChat', ...params }); }
  createSecretChat (params: Omit<types.createSecretChat, '_'>): Promise<any> { return this.invoke({ _: 'createSecretChat', ...params }); }
  createNewBasicGroupChat (params: Omit<types.createNewBasicGroupChat, '_'>): Promise<any> { return this.invoke({ _: 'createNewBasicGroupChat', ...params }); }
  createNewSupergroupChat (params: Omit<types.createNewSupergroupChat, '_'>): Promise<any> { return this.invoke({ _: 'createNewSupergroupChat', ...params }); }
  createNewSecretChat (params: Omit<types.createNewSecretChat, '_'>): Promise<any> { return this.invoke({ _: 'createNewSecretChat', ...params }); }
  upgradeBasicGroupChatToSupergroupChat (params: Omit<types.upgradeBasicGroupChatToSupergroupChat, '_'>): Promise<any> { return this.invoke({ _: 'upgradeBasicGroupChatToSupergroupChat', ...params }); }
  setChatTitle (params: Omit<types.setChatTitle, '_'>): Promise<any> { return this.invoke({ _: 'setChatTitle', ...params }); }
  setChatPhoto (params: Omit<types.setChatPhoto, '_'>): Promise<any> { return this.invoke({ _: 'setChatPhoto', ...params }); }
  setChatDraftMessage (params: Omit<types.setChatDraftMessage, '_'>): Promise<any> { return this.invoke({ _: 'setChatDraftMessage', ...params }); }
  setChatNotificationSettings (params: Omit<types.setChatNotificationSettings, '_'>): Promise<any> { return this.invoke({ _: 'setChatNotificationSettings', ...params }); }
  toggleChatIsPinned (params: Omit<types.toggleChatIsPinned, '_'>): Promise<any> { return this.invoke({ _: 'toggleChatIsPinned', ...params }); }
  toggleChatIsMarkedAsUnread (params: Omit<types.toggleChatIsMarkedAsUnread, '_'>): Promise<any> { return this.invoke({ _: 'toggleChatIsMarkedAsUnread', ...params }); }
  toggleChatDefaultDisableNotification (params: Omit<types.toggleChatDefaultDisableNotification, '_'>): Promise<any> { return this.invoke({ _: 'toggleChatDefaultDisableNotification', ...params }); }
  setChatClientData (params: Omit<types.setChatClientData, '_'>): Promise<any> { return this.invoke({ _: 'setChatClientData', ...params }); }
  joinChat (params: Omit<types.joinChat, '_'>): Promise<any> { return this.invoke({ _: 'joinChat', ...params }); }
  leaveChat (params: Omit<types.leaveChat, '_'>): Promise<any> { return this.invoke({ _: 'leaveChat', ...params }); }
  addChatMember (params: Omit<types.addChatMember, '_'>): Promise<any> { return this.invoke({ _: 'addChatMember', ...params }); }
  addChatMembers (params: Omit<types.addChatMembers, '_'>): Promise<any> { return this.invoke({ _: 'addChatMembers', ...params }); }
  setChatMemberStatus (params: Omit<types.setChatMemberStatus, '_'>): Promise<any> { return this.invoke({ _: 'setChatMemberStatus', ...params }); }
  getChatMember (params: Omit<types.getChatMember, '_'>): Promise<any> { return this.invoke({ _: 'getChatMember', ...params }); }
  searchChatMembers (params: Omit<types.searchChatMembers, '_'>): Promise<any> { return this.invoke({ _: 'searchChatMembers', ...params }); }
  getChatAdministrators (params: Omit<types.getChatAdministrators, '_'>): Promise<any> { return this.invoke({ _: 'getChatAdministrators', ...params }); }
  clearAllDraftMessages (params: Omit<types.clearAllDraftMessages, '_'>): Promise<any> { return this.invoke({ _: 'clearAllDraftMessages', ...params }); }
  getScopeNotificationSettings (params: Omit<types.getScopeNotificationSettings, '_'>): Promise<any> { return this.invoke({ _: 'getScopeNotificationSettings', ...params }); }
  setScopeNotificationSettings (params: Omit<types.setScopeNotificationSettings, '_'>): Promise<any> { return this.invoke({ _: 'setScopeNotificationSettings', ...params }); }
  resetAllNotificationSettings (params: Omit<types.resetAllNotificationSettings, '_'>): Promise<any> { return this.invoke({ _: 'resetAllNotificationSettings', ...params }); }
  setPinnedChats (params: Omit<types.setPinnedChats, '_'>): Promise<any> { return this.invoke({ _: 'setPinnedChats', ...params }); }
  downloadFile (params: Omit<types.downloadFile, '_'>): Promise<any> { return this.invoke({ _: 'downloadFile', ...params }); }
  cancelDownloadFile (params: Omit<types.cancelDownloadFile, '_'>): Promise<any> { return this.invoke({ _: 'cancelDownloadFile', ...params }); }
  uploadFile (params: Omit<types.uploadFile, '_'>): Promise<any> { return this.invoke({ _: 'uploadFile', ...params }); }
  cancelUploadFile (params: Omit<types.cancelUploadFile, '_'>): Promise<any> { return this.invoke({ _: 'cancelUploadFile', ...params }); }
  setFileGenerationProgress (params: Omit<types.setFileGenerationProgress, '_'>): Promise<any> { return this.invoke({ _: 'setFileGenerationProgress', ...params }); }
  finishFileGeneration (params: Omit<types.finishFileGeneration, '_'>): Promise<any> { return this.invoke({ _: 'finishFileGeneration', ...params }); }
  deleteFile (params: Omit<types.deleteFile, '_'>): Promise<any> { return this.invoke({ _: 'deleteFile', ...params }); }
  generateChatInviteLink (params: Omit<types.generateChatInviteLink, '_'>): Promise<any> { return this.invoke({ _: 'generateChatInviteLink', ...params }); }
  checkChatInviteLink (params: Omit<types.checkChatInviteLink, '_'>): Promise<any> { return this.invoke({ _: 'checkChatInviteLink', ...params }); }
  joinChatByInviteLink (params: Omit<types.joinChatByInviteLink, '_'>): Promise<any> { return this.invoke({ _: 'joinChatByInviteLink', ...params }); }
  createCall (params: Omit<types.createCall, '_'>): Promise<any> { return this.invoke({ _: 'createCall', ...params }); }
  acceptCall (params: Omit<types.acceptCall, '_'>): Promise<any> { return this.invoke({ _: 'acceptCall', ...params }); }
  discardCall (params: Omit<types.discardCall, '_'>): Promise<any> { return this.invoke({ _: 'discardCall', ...params }); }
  sendCallRating (params: Omit<types.sendCallRating, '_'>): Promise<any> { return this.invoke({ _: 'sendCallRating', ...params }); }
  sendCallDebugInformation (params: Omit<types.sendCallDebugInformation, '_'>): Promise<any> { return this.invoke({ _: 'sendCallDebugInformation', ...params }); }
  blockUser (params: Omit<types.blockUser, '_'>): Promise<any> { return this.invoke({ _: 'blockUser', ...params }); }
  unblockUser (params: Omit<types.unblockUser, '_'>): Promise<any> { return this.invoke({ _: 'unblockUser', ...params }); }
  getBlockedUsers (params: Omit<types.getBlockedUsers, '_'>): Promise<any> { return this.invoke({ _: 'getBlockedUsers', ...params }); }
  importContacts (params: Omit<types.importContacts, '_'>): Promise<any> { return this.invoke({ _: 'importContacts', ...params }); }
  getContacts (params: Omit<types.getContacts, '_'>): Promise<any> { return this.invoke({ _: 'getContacts', ...params }); }
  searchContacts (params: Omit<types.searchContacts, '_'>): Promise<any> { return this.invoke({ _: 'searchContacts', ...params }); }
  removeContacts (params: Omit<types.removeContacts, '_'>): Promise<any> { return this.invoke({ _: 'removeContacts', ...params }); }
  getImportedContactCount (params: Omit<types.getImportedContactCount, '_'>): Promise<any> { return this.invoke({ _: 'getImportedContactCount', ...params }); }
  changeImportedContacts (params: Omit<types.changeImportedContacts, '_'>): Promise<any> { return this.invoke({ _: 'changeImportedContacts', ...params }); }
  clearImportedContacts (params: Omit<types.clearImportedContacts, '_'>): Promise<any> { return this.invoke({ _: 'clearImportedContacts', ...params }); }
  getUserProfilePhotos (params: Omit<types.getUserProfilePhotos, '_'>): Promise<any> { return this.invoke({ _: 'getUserProfilePhotos', ...params }); }
  getStickers (params: Omit<types.getStickers, '_'>): Promise<any> { return this.invoke({ _: 'getStickers', ...params }); }
  searchStickers (params: Omit<types.searchStickers, '_'>): Promise<any> { return this.invoke({ _: 'searchStickers', ...params }); }
  getInstalledStickerSets (params: Omit<types.getInstalledStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'getInstalledStickerSets', ...params }); }
  getArchivedStickerSets (params: Omit<types.getArchivedStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'getArchivedStickerSets', ...params }); }
  getTrendingStickerSets (params: Omit<types.getTrendingStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'getTrendingStickerSets', ...params }); }
  getAttachedStickerSets (params: Omit<types.getAttachedStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'getAttachedStickerSets', ...params }); }
  getStickerSet (params: Omit<types.getStickerSet, '_'>): Promise<any> { return this.invoke({ _: 'getStickerSet', ...params }); }
  searchStickerSet (params: Omit<types.searchStickerSet, '_'>): Promise<any> { return this.invoke({ _: 'searchStickerSet', ...params }); }
  searchInstalledStickerSets (params: Omit<types.searchInstalledStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'searchInstalledStickerSets', ...params }); }
  searchStickerSets (params: Omit<types.searchStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'searchStickerSets', ...params }); }
  changeStickerSet (params: Omit<types.changeStickerSet, '_'>): Promise<any> { return this.invoke({ _: 'changeStickerSet', ...params }); }
  viewTrendingStickerSets (params: Omit<types.viewTrendingStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'viewTrendingStickerSets', ...params }); }
  reorderInstalledStickerSets (params: Omit<types.reorderInstalledStickerSets, '_'>): Promise<any> { return this.invoke({ _: 'reorderInstalledStickerSets', ...params }); }
  getRecentStickers (params: Omit<types.getRecentStickers, '_'>): Promise<any> { return this.invoke({ _: 'getRecentStickers', ...params }); }
  addRecentSticker (params: Omit<types.addRecentSticker, '_'>): Promise<any> { return this.invoke({ _: 'addRecentSticker', ...params }); }
  removeRecentSticker (params: Omit<types.removeRecentSticker, '_'>): Promise<any> { return this.invoke({ _: 'removeRecentSticker', ...params }); }
  clearRecentStickers (params: Omit<types.clearRecentStickers, '_'>): Promise<any> { return this.invoke({ _: 'clearRecentStickers', ...params }); }
  getFavoriteStickers (params: Omit<types.getFavoriteStickers, '_'>): Promise<any> { return this.invoke({ _: 'getFavoriteStickers', ...params }); }
  addFavoriteSticker (params: Omit<types.addFavoriteSticker, '_'>): Promise<any> { return this.invoke({ _: 'addFavoriteSticker', ...params }); }
  removeFavoriteSticker (params: Omit<types.removeFavoriteSticker, '_'>): Promise<any> { return this.invoke({ _: 'removeFavoriteSticker', ...params }); }
  getStickerEmojis (params: Omit<types.getStickerEmojis, '_'>): Promise<any> { return this.invoke({ _: 'getStickerEmojis', ...params }); }
  getSavedAnimations (params: Omit<types.getSavedAnimations, '_'>): Promise<any> { return this.invoke({ _: 'getSavedAnimations', ...params }); }
  addSavedAnimation (params: Omit<types.addSavedAnimation, '_'>): Promise<any> { return this.invoke({ _: 'addSavedAnimation', ...params }); }
  removeSavedAnimation (params: Omit<types.removeSavedAnimation, '_'>): Promise<any> { return this.invoke({ _: 'removeSavedAnimation', ...params }); }
  getRecentInlineBots (params: Omit<types.getRecentInlineBots, '_'>): Promise<any> { return this.invoke({ _: 'getRecentInlineBots', ...params }); }
  searchHashtags (params: Omit<types.searchHashtags, '_'>): Promise<any> { return this.invoke({ _: 'searchHashtags', ...params }); }
  removeRecentHashtag (params: Omit<types.removeRecentHashtag, '_'>): Promise<any> { return this.invoke({ _: 'removeRecentHashtag', ...params }); }
  getWebPagePreview (params: Omit<types.getWebPagePreview, '_'>): Promise<any> { return this.invoke({ _: 'getWebPagePreview', ...params }); }
  getWebPageInstantView (params: Omit<types.getWebPageInstantView, '_'>): Promise<any> { return this.invoke({ _: 'getWebPageInstantView', ...params }); }
  setProfilePhoto (params: Omit<types.setProfilePhoto, '_'>): Promise<any> { return this.invoke({ _: 'setProfilePhoto', ...params }); }
  deleteProfilePhoto (params: Omit<types.deleteProfilePhoto, '_'>): Promise<any> { return this.invoke({ _: 'deleteProfilePhoto', ...params }); }
  setName (params: Omit<types.setName, '_'>): Promise<any> { return this.invoke({ _: 'setName', ...params }); }
  setBio (params: Omit<types.setBio, '_'>): Promise<any> { return this.invoke({ _: 'setBio', ...params }); }
  setUsername (params: Omit<types.setUsername, '_'>): Promise<any> { return this.invoke({ _: 'setUsername', ...params }); }
  changePhoneNumber (params: Omit<types.changePhoneNumber, '_'>): Promise<any> { return this.invoke({ _: 'changePhoneNumber', ...params }); }
  resendChangePhoneNumberCode (params: Omit<types.resendChangePhoneNumberCode, '_'>): Promise<any> { return this.invoke({ _: 'resendChangePhoneNumberCode', ...params }); }
  checkChangePhoneNumberCode (params: Omit<types.checkChangePhoneNumberCode, '_'>): Promise<any> { return this.invoke({ _: 'checkChangePhoneNumberCode', ...params }); }
  getActiveSessions (params: Omit<types.getActiveSessions, '_'>): Promise<any> { return this.invoke({ _: 'getActiveSessions', ...params }); }
  terminateSession (params: Omit<types.terminateSession, '_'>): Promise<any> { return this.invoke({ _: 'terminateSession', ...params }); }
  terminateAllOtherSessions (params: Omit<types.terminateAllOtherSessions, '_'>): Promise<any> { return this.invoke({ _: 'terminateAllOtherSessions', ...params }); }
  getConnectedWebsites (params: Omit<types.getConnectedWebsites, '_'>): Promise<any> { return this.invoke({ _: 'getConnectedWebsites', ...params }); }
  disconnectWebsite (params: Omit<types.disconnectWebsite, '_'>): Promise<any> { return this.invoke({ _: 'disconnectWebsite', ...params }); }
  disconnectAllWebsites (params: Omit<types.disconnectAllWebsites, '_'>): Promise<any> { return this.invoke({ _: 'disconnectAllWebsites', ...params }); }
  toggleBasicGroupAdministrators (params: Omit<types.toggleBasicGroupAdministrators, '_'>): Promise<any> { return this.invoke({ _: 'toggleBasicGroupAdministrators', ...params }); }
  setSupergroupUsername (params: Omit<types.setSupergroupUsername, '_'>): Promise<any> { return this.invoke({ _: 'setSupergroupUsername', ...params }); }
  setSupergroupStickerSet (params: Omit<types.setSupergroupStickerSet, '_'>): Promise<any> { return this.invoke({ _: 'setSupergroupStickerSet', ...params }); }
  toggleSupergroupInvites (params: Omit<types.toggleSupergroupInvites, '_'>): Promise<any> { return this.invoke({ _: 'toggleSupergroupInvites', ...params }); }
  toggleSupergroupSignMessages (params: Omit<types.toggleSupergroupSignMessages, '_'>): Promise<any> { return this.invoke({ _: 'toggleSupergroupSignMessages', ...params }); }
  toggleSupergroupIsAllHistoryAvailable (params: Omit<types.toggleSupergroupIsAllHistoryAvailable, '_'>): Promise<any> { return this.invoke({ _: 'toggleSupergroupIsAllHistoryAvailable', ...params }); }
  setSupergroupDescription (params: Omit<types.setSupergroupDescription, '_'>): Promise<any> { return this.invoke({ _: 'setSupergroupDescription', ...params }); }
  pinSupergroupMessage (params: Omit<types.pinSupergroupMessage, '_'>): Promise<any> { return this.invoke({ _: 'pinSupergroupMessage', ...params }); }
  unpinSupergroupMessage (params: Omit<types.unpinSupergroupMessage, '_'>): Promise<any> { return this.invoke({ _: 'unpinSupergroupMessage', ...params }); }
  reportSupergroupSpam (params: Omit<types.reportSupergroupSpam, '_'>): Promise<any> { return this.invoke({ _: 'reportSupergroupSpam', ...params }); }
  getSupergroupMembers (params: Omit<types.getSupergroupMembers, '_'>): Promise<any> { return this.invoke({ _: 'getSupergroupMembers', ...params }); }
  deleteSupergroup (params: Omit<types.deleteSupergroup, '_'>): Promise<any> { return this.invoke({ _: 'deleteSupergroup', ...params }); }
  closeSecretChat (params: Omit<types.closeSecretChat, '_'>): Promise<any> { return this.invoke({ _: 'closeSecretChat', ...params }); }
  getChatEventLog (params: Omit<types.getChatEventLog, '_'>): Promise<any> { return this.invoke({ _: 'getChatEventLog', ...params }); }
  getPaymentForm (params: Omit<types.getPaymentForm, '_'>): Promise<any> { return this.invoke({ _: 'getPaymentForm', ...params }); }
  validateOrderInfo (params: Omit<types.validateOrderInfo, '_'>): Promise<any> { return this.invoke({ _: 'validateOrderInfo', ...params }); }
  sendPaymentForm (params: Omit<types.sendPaymentForm, '_'>): Promise<any> { return this.invoke({ _: 'sendPaymentForm', ...params }); }
  getPaymentReceipt (params: Omit<types.getPaymentReceipt, '_'>): Promise<any> { return this.invoke({ _: 'getPaymentReceipt', ...params }); }
  getSavedOrderInfo (params: Omit<types.getSavedOrderInfo, '_'>): Promise<any> { return this.invoke({ _: 'getSavedOrderInfo', ...params }); }
  deleteSavedOrderInfo (params: Omit<types.deleteSavedOrderInfo, '_'>): Promise<any> { return this.invoke({ _: 'deleteSavedOrderInfo', ...params }); }
  deleteSavedCredentials (params: Omit<types.deleteSavedCredentials, '_'>): Promise<any> { return this.invoke({ _: 'deleteSavedCredentials', ...params }); }
  getSupportUser (params: Omit<types.getSupportUser, '_'>): Promise<any> { return this.invoke({ _: 'getSupportUser', ...params }); }
  getWallpapers (params: Omit<types.getWallpapers, '_'>): Promise<any> { return this.invoke({ _: 'getWallpapers', ...params }); }
  getLocalizationTargetInfo (params: Omit<types.getLocalizationTargetInfo, '_'>): Promise<any> { return this.invoke({ _: 'getLocalizationTargetInfo', ...params }); }
  getLanguagePackStrings (params: Omit<types.getLanguagePackStrings, '_'>): Promise<any> { return this.invoke({ _: 'getLanguagePackStrings', ...params }); }
  setCustomLanguagePack (params: Omit<types.setCustomLanguagePack, '_'>): Promise<any> { return this.invoke({ _: 'setCustomLanguagePack', ...params }); }
  editCustomLanguagePackInfo (params: Omit<types.editCustomLanguagePackInfo, '_'>): Promise<any> { return this.invoke({ _: 'editCustomLanguagePackInfo', ...params }); }
  setCustomLanguagePackString (params: Omit<types.setCustomLanguagePackString, '_'>): Promise<any> { return this.invoke({ _: 'setCustomLanguagePackString', ...params }); }
  deleteLanguagePack (params: Omit<types.deleteLanguagePack, '_'>): Promise<any> { return this.invoke({ _: 'deleteLanguagePack', ...params }); }
  registerDevice (params: Omit<types.registerDevice, '_'>): Promise<any> { return this.invoke({ _: 'registerDevice', ...params }); }
  getRecentlyVisitedTMeUrls (params: Omit<types.getRecentlyVisitedTMeUrls, '_'>): Promise<any> { return this.invoke({ _: 'getRecentlyVisitedTMeUrls', ...params }); }
  setUserPrivacySettingRules (params: Omit<types.setUserPrivacySettingRules, '_'>): Promise<any> { return this.invoke({ _: 'setUserPrivacySettingRules', ...params }); }
  getUserPrivacySettingRules (params: Omit<types.getUserPrivacySettingRules, '_'>): Promise<any> { return this.invoke({ _: 'getUserPrivacySettingRules', ...params }); }
  getOption (params: Omit<types.getOption, '_'>): Promise<any> { return this.invoke({ _: 'getOption', ...params }); }
  setOption (params: Omit<types.setOption, '_'>): Promise<any> { return this.invoke({ _: 'setOption', ...params }); }
  setAccountTtl (params: Omit<types.setAccountTtl, '_'>): Promise<any> { return this.invoke({ _: 'setAccountTtl', ...params }); }
  getAccountTtl (params: Omit<types.getAccountTtl, '_'>): Promise<any> { return this.invoke({ _: 'getAccountTtl', ...params }); }
  deleteAccount (params: Omit<types.deleteAccount, '_'>): Promise<any> { return this.invoke({ _: 'deleteAccount', ...params }); }
  getChatReportSpamState (params: Omit<types.getChatReportSpamState, '_'>): Promise<any> { return this.invoke({ _: 'getChatReportSpamState', ...params }); }
  changeChatReportSpamState (params: Omit<types.changeChatReportSpamState, '_'>): Promise<any> { return this.invoke({ _: 'changeChatReportSpamState', ...params }); }
  reportChat (params: Omit<types.reportChat, '_'>): Promise<any> { return this.invoke({ _: 'reportChat', ...params }); }
  getStorageStatistics (params: Omit<types.getStorageStatistics, '_'>): Promise<any> { return this.invoke({ _: 'getStorageStatistics', ...params }); }
  getStorageStatisticsFast (params: Omit<types.getStorageStatisticsFast, '_'>): Promise<any> { return this.invoke({ _: 'getStorageStatisticsFast', ...params }); }
  optimizeStorage (params: Omit<types.optimizeStorage, '_'>): Promise<any> { return this.invoke({ _: 'optimizeStorage', ...params }); }
  setNetworkType (params: Omit<types.setNetworkType, '_'>): Promise<any> { return this.invoke({ _: 'setNetworkType', ...params }); }
  getNetworkStatistics (params: Omit<types.getNetworkStatistics, '_'>): Promise<any> { return this.invoke({ _: 'getNetworkStatistics', ...params }); }
  addNetworkStatistics (params: Omit<types.addNetworkStatistics, '_'>): Promise<any> { return this.invoke({ _: 'addNetworkStatistics', ...params }); }
  resetNetworkStatistics (params: Omit<types.resetNetworkStatistics, '_'>): Promise<any> { return this.invoke({ _: 'resetNetworkStatistics', ...params }); }
  getPassportElement (params: Omit<types.getPassportElement, '_'>): Promise<any> { return this.invoke({ _: 'getPassportElement', ...params }); }
  getAllPassportElements (params: Omit<types.getAllPassportElements, '_'>): Promise<any> { return this.invoke({ _: 'getAllPassportElements', ...params }); }
  setPassportElement (params: Omit<types.setPassportElement, '_'>): Promise<any> { return this.invoke({ _: 'setPassportElement', ...params }); }
  deletePassportElement (params: Omit<types.deletePassportElement, '_'>): Promise<any> { return this.invoke({ _: 'deletePassportElement', ...params }); }
  setPassportElementErrors (params: Omit<types.setPassportElementErrors, '_'>): Promise<any> { return this.invoke({ _: 'setPassportElementErrors', ...params }); }
  getPreferredCountryLanguage (params: Omit<types.getPreferredCountryLanguage, '_'>): Promise<any> { return this.invoke({ _: 'getPreferredCountryLanguage', ...params }); }
  sendPhoneNumberVerificationCode (params: Omit<types.sendPhoneNumberVerificationCode, '_'>): Promise<any> { return this.invoke({ _: 'sendPhoneNumberVerificationCode', ...params }); }
  resendPhoneNumberVerificationCode (params: Omit<types.resendPhoneNumberVerificationCode, '_'>): Promise<any> { return this.invoke({ _: 'resendPhoneNumberVerificationCode', ...params }); }
  checkPhoneNumberVerificationCode (params: Omit<types.checkPhoneNumberVerificationCode, '_'>): Promise<any> { return this.invoke({ _: 'checkPhoneNumberVerificationCode', ...params }); }
  sendEmailAddressVerificationCode (params: Omit<types.sendEmailAddressVerificationCode, '_'>): Promise<any> { return this.invoke({ _: 'sendEmailAddressVerificationCode', ...params }); }
  resendEmailAddressVerificationCode (params: Omit<types.resendEmailAddressVerificationCode, '_'>): Promise<any> { return this.invoke({ _: 'resendEmailAddressVerificationCode', ...params }); }
  checkEmailAddressVerificationCode (params: Omit<types.checkEmailAddressVerificationCode, '_'>): Promise<any> { return this.invoke({ _: 'checkEmailAddressVerificationCode', ...params }); }
  getPassportAuthorizationForm (params: Omit<types.getPassportAuthorizationForm, '_'>): Promise<any> { return this.invoke({ _: 'getPassportAuthorizationForm', ...params }); }
  sendPassportAuthorizationForm (params: Omit<types.sendPassportAuthorizationForm, '_'>): Promise<any> { return this.invoke({ _: 'sendPassportAuthorizationForm', ...params }); }
  sendPhoneNumberConfirmationCode (params: Omit<types.sendPhoneNumberConfirmationCode, '_'>): Promise<any> { return this.invoke({ _: 'sendPhoneNumberConfirmationCode', ...params }); }
  resendPhoneNumberConfirmationCode (params: Omit<types.resendPhoneNumberConfirmationCode, '_'>): Promise<any> { return this.invoke({ _: 'resendPhoneNumberConfirmationCode', ...params }); }
  checkPhoneNumberConfirmationCode (params: Omit<types.checkPhoneNumberConfirmationCode, '_'>): Promise<any> { return this.invoke({ _: 'checkPhoneNumberConfirmationCode', ...params }); }
  setBotUpdatesStatus (params: Omit<types.setBotUpdatesStatus, '_'>): Promise<any> { return this.invoke({ _: 'setBotUpdatesStatus', ...params }); }
  uploadStickerFile (params: Omit<types.uploadStickerFile, '_'>): Promise<any> { return this.invoke({ _: 'uploadStickerFile', ...params }); }
  createNewStickerSet (params: Omit<types.createNewStickerSet, '_'>): Promise<any> { return this.invoke({ _: 'createNewStickerSet', ...params }); }
  addStickerToSet (params: Omit<types.addStickerToSet, '_'>): Promise<any> { return this.invoke({ _: 'addStickerToSet', ...params }); }
  setStickerPositionInSet (params: Omit<types.setStickerPositionInSet, '_'>): Promise<any> { return this.invoke({ _: 'setStickerPositionInSet', ...params }); }
  removeStickerFromSet (params: Omit<types.removeStickerFromSet, '_'>): Promise<any> { return this.invoke({ _: 'removeStickerFromSet', ...params }); }
  getMapThumbnailFile (params: Omit<types.getMapThumbnailFile, '_'>): Promise<any> { return this.invoke({ _: 'getMapThumbnailFile', ...params }); }
  acceptTermsOfService (params: Omit<types.acceptTermsOfService, '_'>): Promise<any> { return this.invoke({ _: 'acceptTermsOfService', ...params }); }
  sendCustomRequest (params: Omit<types.sendCustomRequest, '_'>): Promise<any> { return this.invoke({ _: 'sendCustomRequest', ...params }); }
  answerCustomQuery (params: Omit<types.answerCustomQuery, '_'>): Promise<any> { return this.invoke({ _: 'answerCustomQuery', ...params }); }
  setAlarm (params: Omit<types.setAlarm, '_'>): Promise<any> { return this.invoke({ _: 'setAlarm', ...params }); }
  getCountryCode (params: Omit<types.getCountryCode, '_'>): Promise<any> { return this.invoke({ _: 'getCountryCode', ...params }); }
  getInviteText (params: Omit<types.getInviteText, '_'>): Promise<any> { return this.invoke({ _: 'getInviteText', ...params }); }
  getDeepLinkInfo (params: Omit<types.getDeepLinkInfo, '_'>): Promise<any> { return this.invoke({ _: 'getDeepLinkInfo', ...params }); }
  addProxy (params: Omit<types.addProxy, '_'>): Promise<any> { return this.invoke({ _: 'addProxy', ...params }); }
  editProxy (params: Omit<types.editProxy, '_'>): Promise<any> { return this.invoke({ _: 'editProxy', ...params }); }
  enableProxy (params: Omit<types.enableProxy, '_'>): Promise<any> { return this.invoke({ _: 'enableProxy', ...params }); }
  disableProxy (params: Omit<types.disableProxy, '_'>): Promise<any> { return this.invoke({ _: 'disableProxy', ...params }); }
  removeProxy (params: Omit<types.removeProxy, '_'>): Promise<any> { return this.invoke({ _: 'removeProxy', ...params }); }
  getProxies (params: Omit<types.getProxies, '_'>): Promise<any> { return this.invoke({ _: 'getProxies', ...params }); }
  getProxyLink (params: Omit<types.getProxyLink, '_'>): Promise<any> { return this.invoke({ _: 'getProxyLink', ...params }); }
  pingProxy (params: Omit<types.pingProxy, '_'>): Promise<any> { return this.invoke({ _: 'pingProxy', ...params }); }
  testCallEmpty (params: Omit<types.testCallEmpty, '_'>): Promise<any> { return this.invoke({ _: 'testCallEmpty', ...params }); }
  testCallString (params: Omit<types.testCallString, '_'>): Promise<any> { return this.invoke({ _: 'testCallString', ...params }); }
  testCallBytes (params: Omit<types.testCallBytes, '_'>): Promise<any> { return this.invoke({ _: 'testCallBytes', ...params }); }
  testCallVectorInt (params: Omit<types.testCallVectorInt, '_'>): Promise<any> { return this.invoke({ _: 'testCallVectorInt', ...params }); }
  testCallVectorIntObject (params: Omit<types.testCallVectorIntObject, '_'>): Promise<any> { return this.invoke({ _: 'testCallVectorIntObject', ...params }); }
  testCallVectorString (params: Omit<types.testCallVectorString, '_'>): Promise<any> { return this.invoke({ _: 'testCallVectorString', ...params }); }
  testCallVectorStringObject (params: Omit<types.testCallVectorStringObject, '_'>): Promise<any> { return this.invoke({ _: 'testCallVectorStringObject', ...params }); }
  testSquareInt (params: Omit<types.testSquareInt, '_'>): Promise<any> { return this.invoke({ _: 'testSquareInt', ...params }); }
  testNetwork (params: Omit<types.testNetwork, '_'>): Promise<any> { return this.invoke({ _: 'testNetwork', ...params }); }
  testGetDifference (params: Omit<types.testGetDifference, '_'>): Promise<any> { return this.invoke({ _: 'testGetDifference', ...params }); }
  testUseUpdate (params: Omit<types.testUseUpdate, '_'>): Promise<any> { return this.invoke({ _: 'testUseUpdate', ...params }); }
  testUseError (params: Omit<types.testUseError, '_'>): Promise<any> { return this.invoke({ _: 'testUseError', ...params }); }
}
