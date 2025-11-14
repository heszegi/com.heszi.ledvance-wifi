# Ledvance WiFi Devices for Homey
The missing app for Homey to control LEDVANCE SMART+ WiFi lights.

## Introduction

This app integrates LEDVANCE SMART+ WiFi devices into Homey, allowing you to:

- Turn devices on and off  
- Set light dim levels  
- Adjust light temperature  

## Usage

1. You must have a Homey Pro.  
2. Install the [Ledvance WiFi Homey app](https://homey.app/a/com.heszi.ledvance-wifi) from the Homey App Store.  
3. Add your device to the official LEDVANCE mobile app: [SMART+](https://apps.apple.com/hu/app/smart/id1576461012).  
4. Open the device details and note the following information: **MAC Address**, **Virtual ID**, and **Local Key**.  
5. In Homey, click **Add New Device** and select the **LEDVANCE SMART+ WiFi** app.  
6. Choose your light type.  
7. Select a pairing method:  
   - **Auto Discovery** (Homey may not always find devices based on their MAC address), or  
   - **Manual** — in this case, you must provide the device's **local network IP address**.  
     - The official app usually shows your **public IP**, which is different.  
     - Use your router to find the **local IP** based on the device’s MAC address.  
8. Fill in the required information and add the device.  
9. Enjoy! 🙂