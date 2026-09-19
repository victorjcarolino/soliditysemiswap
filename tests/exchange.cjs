// Exercise the actual compiled contract on an ephemeral, in-process chain. No real funds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const ganache = require('ganache');
const { BrowserProvider, ContractFactory, parseEther, MaxUint256 } = require('ethers');
const root = path.join(__dirname, '..');
const token = `pragma solidity ^0.8.7;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract TestToken is ERC20 {
  constructor() ERC20("Test", "TST") { _mint(msg.sender, 1000000 ether); }
}`;
const input = {
  language: 'Solidity',
  sources: {
    'Exchange.sol': { content: fs.readFileSync(path.join(root, 'contracts/Exchange.sol'), 'utf8') },
    'TestToken.sol': { content: token },
  },
  settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import: name => {
    const filename = path.resolve(root, '.deps/npm', name);
    if (!filename.startsWith(path.resolve(root, '.deps/npm') + path.sep)) return { error: 'Invalid import' };
    return { contents: fs.readFileSync(filename, 'utf8') };
  },
}));
assert.equal((output.errors || []).filter(e => e.severity === 'error').length, 0,
             JSON.stringify(output.errors));
const chain = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 2 } });
(async () => {
  const provider = new BrowserProvider(chain);
  provider.pollingInterval = 10;
  const signer = await provider.getSigner();
  async function deploy(file, name, args = []) {
    const artifact = output.contracts[file][name];
    const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }
  const coin = await deploy('TestToken.sol', 'TestToken');
  const exchange = await deploy('Exchange.sol', 'Exchange', [await coin.getAddress()]);
  await (await coin.approve(await exchange.getAddress(), MaxUint256)).wait();
  await (await exchange.provideLiquidity(parseEther('100'), { value: parseEther('10') })).wait();
  assert.equal(await exchange.totalLiquidityPositions(), 100n);
  await (await exchange.provideLiquidity(parseEther('100'), { value: parseEther('10') })).wait();
  assert.equal(await exchange.totalLiquidityPositions(), 200n, 'equal deposit must mint equal shares');
  await assert.rejects(() => exchange.provideLiquidity.staticCall(10n, { value: 1n }),
                       /zero liquidity positions/);
  await assert.rejects(() => exchange.provideLiquidity.staticCall(parseEther('100.5'), { value: parseEther('10') }),
                       /maintain Wei\/ERC20 ratio/);
  await assert.rejects(() => exchange.provideLiquidity.staticCall(parseEther('99.5'), { value: parseEther('10') }),
                       /maintain Wei\/ERC20 ratio/);
  const deadline = BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const outEth = await exchange.estimateSwapForEth(parseEther('1'));
  await assert.rejects(() => exchange.swapForEth.staticCall(parseEther('1'), outEth + 1n, deadline));
  await assert.rejects(() => exchange.swapForEth.staticCall(parseEther('1'), 0, 0));
  await (await exchange.swapForEth(parseEther('1'), outEth, deadline)).wait();
  const outTokens = await exchange.estimateSwapForERC20Token(parseEther('1'));
  await assert.rejects(() => exchange.swapForERC20Token.staticCall(outTokens + 1n, deadline, { value: parseEther('1') }));
  await assert.rejects(() => exchange.swapForERC20Token.staticCall(0, 0, { value: parseEther('1') }));
  await (await exchange.swapForERC20Token(outTokens, deadline, { value: parseEther('1') })).wait();
  await (await exchange.withdrawLiquidity(100)).wait();
  assert.equal(await exchange.totalLiquidityPositions(), 100n);
  console.log('PASS: proportional liquidity, zero-share rejection, min outputs, deadlines, swaps, withdrawal');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => chain.disconnect());
