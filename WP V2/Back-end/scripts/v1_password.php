<?php

function decrypt_v1_password(string $encrypted): ?string
{
    $encryptMethod = 'AES-256-CBC';
    $secretKey = 'AA74CDCC2BBRT935136HH7B63C27';
    $secretIv = '5fgf5HJ5g27';
    $key = hash('sha256', $secretKey);
    $iv = substr(hash('sha256', $secretIv), 0, 16);
    $plain = openssl_decrypt(base64_decode($encrypted), $encryptMethod, $key, 0, $iv);

    return $plain === false ? null : $plain;
}

if (PHP_SAPI === 'cli' && isset($argv[1])) {
    $plain = decrypt_v1_password($argv[1]);
    if ($plain === null) {
        fwrite(STDERR, "decrypt failed\n");
        exit(1);
    }
    echo json_encode([
        'hash' => password_hash($plain, PASSWORD_BCRYPT),
        'plain' => $plain,
    ], JSON_UNESCAPED_UNICODE);
    exit(0);
}
