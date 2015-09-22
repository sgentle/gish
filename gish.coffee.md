Gish
====

Gish is a library and command-line utility for hashing files and directories. It
will provide you with a consistent hash that will not change unless the
underlying files change.

Gish is designed to produce identical output to git's object system. That is,
`git hash-object myfile` and `gish myfile` should produce identical output. And
`gish mydirectory` should produce an identical object to the git tree of the
same directory. (There is no git command to do this for arbitrary directories,
but you can do something like `git show -s --format=%T HEAD` to show a directory
that's already been checked in).

To install as a command-line tool, just `npm install -g gish`. You can also
`require()` it from nodejs.

Libraries and helper functions
------------------------------

Bluebird is optional, but it's faster than node core Promises.

    crypto = require 'crypto'
    fs = require 'fs'
    path = require 'path'
    Promise = require 'bluebird'

We promisify all our fs calls. These functions assume only one argument because
that's true for our purposes and it's faster than using varargs.

    promisify = (fn) -> (arg) ->
      new Promise (resolve, reject) ->
        fn arg, (err, result) ->
          if err then reject err else resolve result

    stat = promisify fs.lstat
    readdir = promisify fs.readdir
    readlink = promisify fs.readlink

Standard Promisey memoise function. setInterval isn't such a great cache expiry
function but it works well enough.

    memo = (f) ->
      cache = {}
      setInterval((-> cache = {}), 1000).unref()
      (arg) -> if result = cache[arg] then result else cache[arg] = f(arg)

We call stat a lot, so it makes sense to memoise it and save on syscalls.

    stat = memo stat

Limit a function to `max` simultaneous pending Promises. If we don't do this we
run out of file descriptors.

    limit = (max, f) ->
      n = 0
      queue = []
      dec = (x) -> n--; queue.pop()?(); x

      (arg) ->
        n++
        if n <= max
          f(arg).then(dec)
        else
          (new Promise (resolve, reject) -> queue.push resolve)
          .then -> f(arg).then(dec)

Basic hashing functions
-----------------------

`hashFile` just performs a standard sha1 on the file contents, but it has to
write the git blob header first.

    hashFile = limit 100, (file) ->
      stat(file).then (stats) ->
        readStream = fs.createReadStream file
        readStream.on 'error', (e) -> throw e
        hash = crypto.createHash 'sha1'
        hash.on 'error', (e) -> throw e

        hash.write "blob #{stats.size}\0"
        readStream.pipe hash

        new Promise (resolve, reject) ->
          hash.on 'finish', -> resolve hash.read()

`hashLink` works basically the same as hashFile. Because symlinks are small we
can just read it into memory.

    hashLink = limit 100, (file) ->
      readlink(file).then (link) ->
        buf = new Buffer link
        hash = crypto.createHash 'sha1'
        hash.write "blob #{buf.length}\0"
        hash.write buf
        hash.end()
        hash.read()

Tree hashing
------------

Hashing a tree is somewhat complex. Git trees are a list of tree entries that
look like this:

`100644 foo.txt\0HASH`

The first part is the file mode + some extra git bits indicating whether it's a
file, directory or symlink. Then comes the filename terminated with a NUL, then
the hash as binary data.

Git only supports mode 644 or 755, so we only support mode 644 or 755.

    MODES =
      file: 0b1000 << 12 | 0o644
      file_x: 0b1000 << 12 | 0o755
      dir: 0b0100 << 12
      link: 0b1010 << 12

    EXECUTABLE = 0o100

`treeEntry` generates one line of the git tree.

    treeEntry = (dir, name) ->
      file = path.join dir, name
      hash = hashAnything file
      fmt = stat(file)
      .then (stats) ->
        if stats.isDirectory() then 'dir'
        else if stats.isSymbolicLink() then 'link'
        else if stats.isFile()
          if stats.mode & EXECUTABLE then 'file_x' else 'file'
        else
          throw new Error "unhashable file: #{file}"

      .then (mode) ->
        buf = new Buffer "#{MODES[mode].toString(8)} #{name}\0", 'utf8'

      Promise.all([fmt, hash]).then Buffer.concat

git doesn't sort like other people sort. It basically adds a slash to the end of
every directory before sorting. I think it does this so that the sorting stays
stable when files and directories with the same name are present (not possible
for us, but it could happen when comparing different trees).

    watSort = (dir) -> (files) ->
      Promise.all files.map (file) ->
        stat(path.join(dir, file)).then (stats) ->
          if stats.isDirectory()
            file + '/'
          else
            file
      .then (files) ->
        files.sort().map (x) -> x.replace /\/$/, ''

git ignores empty directories, so we make a special exception that we can send
up the Promise chain and filter out when we're building subdirectories.

    class EmptyDirectoryError extends Error
      name: 'EmptyDirectoryError'
      constructor: ->

`hashTree` is the holy grail: it gives us the (recursive) hash of a directory
tree by joining together and hashing all the tree entries.

We ignore .git directories because who wants to hash their git directory?

    hashTree = limit 100, (dir) ->
      readdir dir
      .then watSort(dir)
      .then (files) ->
        files = files.filter((x) -> x isnt '.git')
        if files.length is 0
          throw new EmptyDirectoryError "can't hash an empty directory"

        files.map (name) ->
          treeEntry dir, name
          .catch (e) ->
            throw e unless e instanceof EmptyDirectoryError
            null

      .then Promise.all.bind(Promise)

      .then (entries) ->
        size = 0
        size += e.length for e in entries when e
        hash = crypto.createHash 'sha1'
        hash.write "tree #{size}\0"
        hash.write entry for entry in entries when entry
        hash.end()
        hash.read()

hashAnything is a convenience function that stats the file and delegates to the
appropriate specialised hashing function.

    hashAnything = (file) ->
      stat(file).then (stats) ->
        if stats.isDirectory() then hashTree file
        else if stats.isSymbolicLink() then hashLink file
        else if stats.isFile() then hashFile file
        else throw new Error "unhashable file: #{file}"

It's also our main export. But we provide the others too under gish.hashTree
etc.

    module.exports = hashAnything
    hashAnything[k] = v for k, v of {hashTree, hashLink, hashFile, treeEntry}
