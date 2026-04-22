// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AssetScanner {
    struct Result { uint256 balance; uint8 decimals; string name; string symbol; bool isNonFungible; }

    function scan(address owner, address[] calldata tokens)
        external view returns (Result[] memory out)
    {
        out = new Result[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            (bool okB, bytes memory bal) = t.staticcall(abi.encodeWithSelector(0x70a08231, owner));
            if (okB && bal.length >= 32) out[i].balance = abi.decode(bal, (uint256));

            (bool okD, bytes memory dec) = t.staticcall(abi.encodeWithSelector(0x313ce567));
            if (okD && dec.length >= 32) out[i].decimals = uint8(abi.decode(dec, (uint256)));

            (bool okN, bytes memory nm) = t.staticcall(abi.encodeWithSelector(0x06fdde03));
            if (okN) out[i].name = _decodeStringOrBytes32(nm);

            (bool okS, bytes memory sy) = t.staticcall(abi.encodeWithSelector(0x95d89b41));
            if (okS) out[i].symbol = _decodeStringOrBytes32(sy);

            // ERC-165 supportsInterface(0x80ac58cd) — ERC-721. Non-ERC-165 contracts revert; treat as false.
            (bool okI, bytes memory sup) = t.staticcall(abi.encodeWithSelector(0x01ffc9a7, bytes4(0x80ac58cd)));
            if (okI && sup.length >= 32) out[i].isNonFungible = abi.decode(sup, (bool));
        }
    }

    function _decodeStringOrBytes32(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        if (data.length == 32) {
            uint256 len;
            while (len < 32 && data[len] != 0) ++len;
            bytes memory trimmed = new bytes(len);
            for (uint256 i; i < len; ++i) trimmed[i] = data[i];
            return string(trimmed);
        }
        if (data.length >= 64) return abi.decode(data, (string));
        return "";
    }
}
