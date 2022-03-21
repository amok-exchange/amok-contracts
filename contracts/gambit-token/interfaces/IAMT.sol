// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

interface IAMT {
    function beginMigration() external;
    function endMigration() external;
}
