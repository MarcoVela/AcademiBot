const {S3, MySQL, FB} = require('../src/Instances');
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    const action = req.query['action'];
    switch (action) {
        case 'download':
            const key = req.query['key'];
            if (!key) return res.sendStatus(500);
            return S3.getObject(key)
                .then(data => res.send(data.Body))
                .catch(e => {
                    MySQL.logInternalError(e, 'API');
                    res.sendStatus(500);
                });
        case 'usuarios':
            return MySQL.getAllUsers()
                .then(usuarios => res.send(usuarios))
                .catch(e => {
                    MySQL.logInternalError(e, 'API');
                    res.sendStatus(500);
                });
        case 'info':
            const userId = req.query['user'];
            if (!userId) return res.sendStatus(500);
            return FB.getUserInfo(userId)
                .then(info => res.send(info))
                .catch(e => {
                    MySQL.logInternalError(e, 'API');
                    res.sendStatus(500);
                });
        case 'list':
            const prefix = req.query['prefix'];
            if (!prefix) return res.sendStatus(500);
            return S3.listObjectsUnder(prefix)
                .then(keys => res.send(keys))
                .catch(e => {
                    MySQL.logInternalError(e, 'API');
                    res.sendStatus(500);
                });
        default:
            res.sendStatus(405);
    }
});
module.exports = router;