declare module 'socks-proxy-agent' {
  import { Agent } from 'http'

  class SocksProxyAgent extends Agent {
    constructor(url: string)
  }
  export default SocksProxyAgent
}
