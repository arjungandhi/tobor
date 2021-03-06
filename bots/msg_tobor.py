#importing useful stuff
import discord
import json
import subprocess
import os


async def msg_processor(perms ,message, client):
    if message.content.startswith(perms['command_key']) and message.channel.id in perms['super']['channels']:
        message = pop_command_key(message, perms)

        args = message.content.split(' ')
        # remove empty strings 
        args = [a for a in args if a != '']
        
        await command_handler( message, args, client)

#msg_commands
async def post(message, args, client):
    
    try:
        #get channel id 
        channel_id = int(args.pop(0))

        #post message
        message_content = ' '.join(args)

        channel = client.get_channel(channel_id)

        if channel: 
            sent_msg = await channel.send(message_content)
            await message.channel.send(f'I do the post, message id: {sent_msg.id}')
        else:
            await message.channel.send(f'No channel with ID: {channel_id}')


    except (ValueError, IndexError):
        await message.channel.send(f't! msg post <channel_id> <msg content>')

async def edit(message, args, client):
    #get channel id 
    try:
        channel_id = int(args.pop(0))
        message_id = int(args.pop(0))
        
        #post message
        message_content = ' '.join(args)

        channel = client.get_channel(channel_id)
        

        if channel:
            msg = await channel.fetch_message(message_id)
            if msg: 
                await msg.edit(content=message_content)
                await message.channel.send(f'I did edit, message id: {msg.id}')
            else:
                await message.channel.send(f'No message with ID: {message_id} in channel {channel_id}')
        else:
            await message.channel.send(f'No channel with ID: {channel_id}')

    except (ValueError, IndexError):
        await message.channel.send(f't! msg edit <channel_id> <message_id> content')

async def delete(message, args, client):
    #get channel id 
    try:
        channel_id = int(args.pop(0))
        message_id = int(args.pop(0))
        

        channel = client.get_channel(channel_id)
        

        if channel:
            msg = await channel.fetch_message(message_id)
            if msg: 
                await msg.delete()
                await message.channel.send(f'It is gone now')
            else:
                await message.channel.send(f'No message with ID: {message_id} in channel {channel_id}')
        else:
            await message.channel.send(f'No channel with ID: {channel_id}')

    except (ValueError, IndexError):
        await message.channel.send(f't! msg delete <channel_id> <message_id>')

   



#command handler
async def command_handler(message, args, client):

    msg_commands= {
        'post'   : post,
        'edit'   : edit,
        'delete' : delete
    }


    if args[0] == 'msg':
        del args[0]
        if args[0] in msg_commands.keys():
            cmd = args.pop(0)
            await msg_commands[cmd](message, args, client)
        else: 
            await message.channel.send(f'No command {args[0]} in msg command')







#purge message command_key
def pop_command_key(message,perms):
    message.content = message.content[len(perms['command_key']):]
    return message

#reloads perms.json
def update_perms():
    #running a git pull to get most recent changes
    with open('./perms.json', 'r') as f:
        return json.loads(f.read())
    print('updated json')


