const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth'));
router.use('/articles', require('./articles'));
router.use('/categories', require('./categories'));
router.use('/upload', require('./upload'));
router.use('/contact', require('./contact'));
router.use('/contacts', require('./contact'));
router.use('/seo', require('./seo'));
router.use('/redirects', require('./redirects'));

module.exports = router;
