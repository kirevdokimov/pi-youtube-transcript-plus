# pi-youtube-transcript-plus

A pi extension which utilizes [youtube-transcript-plus](https://github.com/ericmmartin/youtube-transcript-plus) to fetch youtube transcripts.

It never fill the whole context window with transcript, but writes a transcript to a file for agent to read.

## Install

```sh
pi install npm:pi-youtube-transcript-plus

# Install a package temporarily without adding it to your setup
pi -e npm:pi-youtube-transcript-plus
```
